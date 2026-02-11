import express from 'express';
import { connectDB } from '../services/mongodb.js';
import { Profile } from '../models/Profile.js';
import { AutomationOrchestrator } from '../orchestrator.js';
import { AdsPowerService } from '../services/adspower.js';
import { InteractionLog } from '../models/InteractionLog.js';
import { TrustScore } from '../models/TrustScore.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const orchestrator = new AutomationOrchestrator(10);
const adspower = new AdsPowerService();

app.get('/api/groups', async (req, res) => {
  try {
    const forceRefresh = req.query.force === 'true' || req.query.refresh === 'true';
    const groups = await adspower.getGroups(forceRefresh);
    // Always return success with data (even if empty array)
    // getGroups never throws - it returns empty array on error
    res.json({ success: true, data: groups || [] });
  } catch (error) {
    // Fallback: if somehow an error is thrown, return empty array
    console.error('Unexpected error in /api/groups:', error);
    res.json({ success: true, data: [] });
  }
});

app.post('/api/groups/create', async (req, res) => {
  try {
    const { groupName } = req.body;
    if (!groupName || !groupName.trim()) {
      return res.status(400).json({ success: false, error: 'Group name is required' });
    }
    const group = await adspower.createGroup(groupName.trim());
    res.json({ success: true, data: group });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/profiles', async (req, res) => {
  try {
    const profiles = await Profile.findAll();
    const adspowerService = new AdsPowerService();

    // Build name + device map from AdsPower V2 list in one pass (avoids slow per-profile getProfileDetails).
    const adspowerNameMap = {};
    const adspowerDataById = {};
    try {
      let page = 1;
      const limit = 100;
      let list = [];
      for (;;) {
        const v2 = await adspowerService.getProfileListV2(page, limit);
        const chunk = v2?.list || [];
        list = list.concat(chunk);
        if (chunk.length < limit) break;
        page += 1;
        await new Promise((r) => setTimeout(r, 2500));
      }
      list.forEach((p) => {
        const id = p.profile_id ?? p.user_id ?? p.id;
        if (id == null) return;
        const sid = String(id);
        const rawName = p.name != null ? String(p.name).trim() : '';
        const name = rawName !== '' ? rawName : (p.profile_no != null ? String(p.profile_no) : null);
        if (name != null) {
          adspowerNameMap[sid] = name;
          adspowerNameMap[String(p.profile_id)] = name;
          adspowerNameMap[String(p.user_id)] = name;
        }
        adspowerDataById[sid] = p;
      });
    } catch (_) {}

    const syncedProfiles = profiles.map((profile) => {
      const sid = String(profile.adspowerId);
      const name = adspowerNameMap[sid] ?? profile.adspowerId ?? '—';
      const adspowerData = adspowerDataById[sid] || null;
      const wantSync = req.query.syncDeviceInfo === 'true' || !profile.operatingSystem || !profile.userAgent;

      if (adspowerData && wantSync) {
        const osType = adspowerData.os_type || adspowerData.osType || adspowerData.operating_system || '';
        // Use extractUserAgent for list endpoint (faster, no async call needed)
        const userAgent = adspowerService.extractUserAgent(adspowerData) || '';
        
        if ((osType || userAgent) && (osType !== profile.operatingSystem || userAgent !== profile.userAgent)) {
          Profile.update(profile.adspowerId, {
            ...(osType && { operatingSystem: osType }),
            ...(userAgent && { userAgent })
          }).catch(() => {});
          return { ...profile, name, operatingSystem: osType || profile.operatingSystem, userAgent: userAgent || profile.userAgent };
        }
      }
      return { ...profile, name };
    });

    // Add lastUsed = most recent of lastFarmed, lastDnaAt, lastCheckAt
    // Also get latest trust score from diagnostics if profile.trustScore is 0 or missing
    let activityByProfile = {};
    let diagnosticsByProfile = {};
    try {
      activityByProfile = await InteractionLog.getLatestActivityByProfile();
      // Get latest diagnostics for each profile to get trust scores
      const allLogs = await InteractionLog.findAll(10000);
      allLogs.forEach(log => {
        if (log.action === 'diagnostics_check' && log.metadata && log.metadata.antcptScore !== null && log.metadata.antcptScore !== undefined) {
          const id = String(log.profileId);
          if (!diagnosticsByProfile[id] || (diagnosticsByProfile[id].timestamp < log.timestamp)) {
            diagnosticsByProfile[id] = {
              antcptScore: log.metadata.antcptScore,
              timestamp: log.timestamp
            };
          }
        }
      });
    } catch (e) {
      console.error('Error fetching latest activity for profiles:', e);
    }
    const withLastUsed = syncedProfiles.map((p) => {
      const id = String(p.adspowerId);
      const act = activityByProfile[id] || {};
      const lastFarmed = p.lastFarmed ? new Date(p.lastFarmed) : null;
      const lastDnaAt = act.lastDnaAt ? new Date(act.lastDnaAt) : null;
      const lastCheckAt = act.lastCheckAt ? new Date(act.lastCheckAt) : null;
      const dates = [lastFarmed, lastDnaAt, lastCheckAt].filter(Boolean);
      const lastUsed = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
      
      // Use trustScore from profile, or fallback to latest diagnostics antcptScore if profile.trustScore is 0 or missing
      let trustScore = p.trustScore;
      if ((!trustScore || trustScore === 0) && diagnosticsByProfile[id] && diagnosticsByProfile[id].antcptScore !== null && diagnosticsByProfile[id].antcptScore !== undefined) {
        trustScore = diagnosticsByProfile[id].antcptScore;
      }
      
      return { ...p, lastUsed: lastUsed ? lastUsed.toISOString() : null, trustScore: trustScore || 0 };
    });

    res.json({ success: true, data: withLastUsed });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/profiles/:id', async (req, res) => {
  try {
    const profile = await Profile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    // Prefer Name, User Agent, and OS from AdsPower app when available
    let adspowerName = null;
    let adspowerUserAgent = null;
    let adspowerOs = null;
    try {
      const adspowerService = new AdsPowerService();
      const adspowerDetails = await adspowerService.getProfileDetails(req.params.id);
      const d = adspowerDetails?.data;
      const adspowerData = (d && Array.isArray(d.list) && d.list[0]) ? d.list[0] : (d || adspowerDetails?.list?.[0] || {});
      const raw = adspowerData.name ?? adspowerData.user_name ?? adspowerData.remark;
      adspowerName = (raw != null && String(raw).trim() !== '') ? String(raw).trim() : null;
      // Use dedicated UA endpoint to get user agent
      console.log(`Fetching user agent for profile ${req.params.id}...`);
      const ua = await adspowerService.getUserAgent(req.params.id);
      adspowerUserAgent = (ua && String(ua).trim() !== '') ? String(ua).trim() : null;
      
      if (adspowerUserAgent) {
        console.log(`✓ User agent found from UA endpoint: ${adspowerUserAgent.substring(0, 50)}...`);
      } else {
        console.log(`⚠ UA endpoint returned no user agent, trying fallback...`);
        // Fallback to extractUserAgent if UA endpoint didn't return anything
        const uaFallback = adspowerService.extractUserAgent(adspowerData);
        adspowerUserAgent = (uaFallback && String(uaFallback).trim() !== '') ? String(uaFallback).trim() : null;
        if (adspowerUserAgent) {
          console.log(`✓ User agent found from fallback: ${adspowerUserAgent.substring(0, 50)}...`);
        } else {
          console.log(`✗ User agent not found in AdsPower data`);
        }
      }
      
      const os = adspowerData.os_type ?? adspowerData.osType ?? adspowerData.operating_system ?? '';
      adspowerOs = (os && String(os).trim() !== '') ? String(os).trim() : null;
      
      // If we found user agent or OS from AdsPower, update the profile (even if profile already has it, to keep it in sync)
      if (adspowerUserAgent || adspowerOs) {
        const updates = {};
        if (adspowerUserAgent) updates.userAgent = adspowerUserAgent;
        if (adspowerOs) updates.operatingSystem = adspowerOs;
        if (Object.keys(updates).length > 0) {
          Profile.update(req.params.id, updates).catch(err => {
            console.warn('Could not update profile with AdsPower data:', err.message);
          });
        }
      }
    } catch (error) {
      console.warn('Could not fetch AdsPower details:', error.message);
    }

    let diagnosticsResult = null;
    let lastDnaAt = null;
    let lastCheckAt = null;
    try {
      const logs = await InteractionLog.findByProfile(req.params.id, 50);
      const latestDiagnostics = logs.find(log => log.action === 'diagnostics_check');
      const latestDna = logs.find(log => log.action === 'dna_analysis');
      if (latestDiagnostics && latestDiagnostics.metadata) {
        diagnosticsResult = {
          antcptScore: latestDiagnostics.metadata.antcptScore !== undefined && latestDiagnostics.metadata.antcptScore !== null ? latestDiagnostics.metadata.antcptScore : null,
          myadscenterPassed: latestDiagnostics.metadata.myadscenterPassed !== undefined ? latestDiagnostics.metadata.myadscenterPassed : null,
          youtubePassed: latestDiagnostics.metadata.youtubePassed !== undefined ? latestDiagnostics.metadata.youtubePassed : null,
          youtubeBanned: latestDiagnostics.metadata.youtubeBanned || false,
          youtubeNoAccount: latestDiagnostics.metadata.youtubeNoAccount || false,
          timestamp: latestDiagnostics.timestamp
        };
        lastCheckAt = latestDiagnostics.timestamp || null;
      }
      if (latestDna && latestDna.timestamp) lastDnaAt = latestDna.timestamp;
    } catch (diagError) {
      console.error('Error fetching diagnostics result:', diagError);
    }

    // Extract YouTube status and Invalid Account status from notes
    let youtubeStatus = null;
    let isInvalidAccount = false;
    if (profile.notes) {
      const notesLower = profile.notes.toLowerCase();
      if (notesLower.includes('banned youtube')) {
        youtubeStatus = 'Banned Youtube';
      } else if (notesLower.includes('no youtube account')) {
        youtubeStatus = 'No YouTube Account';
      } else if (notesLower.includes('youtube account created')) {
        youtubeStatus = 'YouTube Account Created';
      }
      if (notesLower.includes('invalid account')) {
        isInvalidAccount = true;
      }
    }

    const profileData = {
      ...profile,
      name: adspowerName ?? profile.adspowerId ?? '—',
      userAgent: adspowerUserAgent ?? profile.userAgent ?? profile.user_agent ?? '',
      operatingSystem: adspowerOs ?? profile.operatingSystem ?? profile.os_type ?? '',
      lastFarmed: profile.lastFarmed || null,
      lastDnaAt: lastDnaAt || null,
      lastCheckAt: lastCheckAt || null,
      diagnosticsResult: diagnosticsResult,
      youtubeStatus: youtubeStatus,
      isInvalidAccount: isInvalidAccount
    };
    res.json({ success: true, data: profileData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/profiles/create', async (req, res) => {
  try {
    const { email, password, recoveryEmail, proxy, adspowerId } = req.body;

    const result = await orchestrator.runIntakeProcess({
      email,
      password,
      recoveryEmail,
      proxy,
      adspowerId
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/profiles/bulk-create', async (req, res) => {
  try {
    const useSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');
    
    if (useSSE) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.flushHeaders();
    }
    
    console.log('Bulk create request received:', {
      profileAmount: req.body.profileAmount,
      profileGroup: req.body.profileGroup,
      proxyType: req.body.proxyType,
      proxiesCount: req.body.proxies?.length || 0,
      accountsCount: req.body.accounts?.length || 0,
      useSSE
    });
    
    const { 
      proxies, 
      accounts,
      proxyType,
      profileName, 
      profileAmount,
      profileGroup, 
      operatingSystem, 
      userAgent,
      deviceMemory,
      hardwareConcurrency,
      resolutionMode,
      screenResolution
    } = req.body;

    if (proxyType === 'custom' && (!Array.isArray(proxies) || proxies.length === 0)) {
      console.error('Validation failed: Proxies required for custom proxy type');
      if (useSSE) {
        res.write(`data: ${JSON.stringify({ error: 'Proxies are required when using custom proxy list' })}\n\n`);
        res.end();
      } else {
        return res.status(400).json({ 
          success: false, 
          error: 'Proxies are required when using custom proxy list' 
        });
      }
      return;
    }

    console.log('Starting bulk profile creation...');
    
    const progressCallback = useSSE ? (progress) => {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
    } : null;
    
    const results = await orchestrator.runBulkProfileCreation(proxies || [], {
      accounts: accounts || [],
      profileName,
      profileAmount,
      profileGroup,
      operatingSystem,
      userAgent,
      proxyType: proxyType || 'noproxy',
      deviceMemory,
      hardwareConcurrency,
      resolutionMode,
      screenResolution
    }, progressCallback);

    console.log('Bulk profile creation completed:', {
      total: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    });

    if (useSSE) {
      res.write(`data: ${JSON.stringify({ completed: true, total: results.length, successful: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length })}\n\n`);
      res.end();
    } else {
      res.json({ 
        success: true, 
        data: {
          total: results.length,
          successful: results.filter(r => r.success).length,
          failed: results.filter(r => !r.success).length,
          results: results
        }
      });
    }
  } catch (error) {
    console.error('Bulk profile creation error:', error);
    if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

app.post('/api/profiles/:id/dna-analysis', async (req, res) => {
  try {
    const runHidden = req.body?.runHidden !== false;
    const result = await orchestrator.runDNAAnalysis(req.params.id, { runHidden });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/profiles/:id/diagnostics', async (req, res) => {
  try {
    const runHidden = req.body?.runHidden !== false;
    const result = await orchestrator.runQualityCheck(req.params.id, { runHidden });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/profiles/bulk-diagnostics', async (req, res) => {
  try {
    const { profileIds } = req.body;
    
    if (!Array.isArray(profileIds) || profileIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'profileIds array is required' 
      });
    }

    console.log(`Bulk diagnostics request received for ${profileIds.length} profile(s)`);
    const runHidden = req.body?.runHidden !== false;

    // Process all profiles through the queue
    const promises = profileIds.map(async (profileId) => {
      try {
        const result = await orchestrator.runQualityCheck(profileId, { runHidden });
        return { profileId, success: true, data: result };
      } catch (error) {
        return { profileId, success: false, error: error.message };
      }
    });

    const results = await Promise.allSettled(promises);
    
    const formattedResults = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return { 
          profileId: profileIds[index], 
          success: false, 
          error: result.reason?.message || 'Unknown error' 
        };
      }
    });

    const successful = formattedResults.filter(r => r.success).length;
    const failed = formattedResults.filter(r => !r.success).length;

    console.log(`Bulk diagnostics completed: ${successful} successful, ${failed} failed`);

    res.json({ 
      success: true, 
      data: {
        total: profileIds.length,
        successful,
        failed,
        results: formattedResults
      }
    });
  } catch (error) {
    console.error('Bulk diagnostics error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/profiles/:id/farm', async (req, res) => {
  try {
    const runHidden = req.body?.runHidden !== false;
    const result = await orchestrator.runFarming(req.params.id, { runHidden });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/campaigns/create', async (req, res) => {
  try {
    const { name, profileIds, action } = req.body;
    const runHidden = req.body?.runHidden !== false;
    const options = { runHidden };

    const results = [];
    for (const profileId of profileIds) {
      try {
        let result;
        if (action === 'farm') {
          result = await orchestrator.runFarming(profileId, options);
        } else if (action === 'diagnostics') {
          result = await orchestrator.runQualityCheck(profileId, options);
        } else if (action === 'dna') {
          result = await orchestrator.runDNAAnalysis(profileId, options);
        }
        results.push({ profileId, success: true, result });
      } catch (error) {
        results.push({ profileId, success: false, error: error.message });
      }
    }

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/profiles/:id/logs', async (req, res) => {
  try {
    const logs = await InteractionLog.findByProfile(req.params.id);
    res.json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 500;
    const logs = await InteractionLog.findAll(limit);
    res.json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/profiles/:id/trust-scores', async (req, res) => {
  try {
    const scores = await TrustScore.getHistory(req.params.id);
    res.json({ success: true, data: scores });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`Attempting to delete profile: ${id}`);
    
    let adspowerDeleted = false;
    try {
      await adspower.deleteProfile(id);
      adspowerDeleted = true;
      console.log(`✓ Profile ${id} deleted from AdsPower`);
    } catch (adspowerError) {
      console.warn(`⚠ Failed to delete profile ${id} from AdsPower:`, adspowerError.message);
      console.warn('Continuing with MongoDB deletion...');
    }
    
    let mongoDeleted = false;
    try {
      let result;
      if (typeof Profile.delete === 'function') {
        result = await Profile.delete(id);
      } else {
        console.warn('⚠ Profile.delete method not found, using direct MongoDB deletion');
        const { getDB } = await import('../services/mongodb.js');
        const { dbConfig } = await import('../config/database.js');
        const db = getDB();
        const collection = db.collection(dbConfig.collections.profiles);
        result = await collection.deleteOne({ adspowerId: id });
      }
      
      mongoDeleted = result.deletedCount > 0;
      
      if (!mongoDeleted) {
        console.warn(`⚠ Profile ${id} not found in MongoDB`);
        return res.status(404).json({ 
          success: false, 
          error: 'Profile not found in database',
          adspowerDeleted 
        });
      }
      
      console.log(`✓ Profile ${id} deleted from MongoDB`);
      res.json({ 
        success: true, 
        message: 'Profile deleted successfully',
        adspowerDeleted,
        mongoDeleted: true
      });
    } catch (mongoError) {
      console.error(`✗ Error deleting profile ${id} from MongoDB:`, mongoError);
      throw mongoError;
    }
  } catch (error) {
    console.error('✗ Error deleting profile:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Unknown error occurred',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.get('/api/queue/status', (req, res) => {
  try {
    const status = orchestrator.getQueueStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/daily-farming', async (req, res) => {
  try {
    const results = await orchestrator.runDailyFarming();
    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

export async function startDashboard() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Dashboard running on http://localhost:${PORT}`);
  });
}
