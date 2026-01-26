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
app.use(express.static(path.join(__dirname, 'public')));

const orchestrator = new AutomationOrchestrator(10);
const adspower = new AdsPowerService();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/groups', async (req, res) => {
  try {
    const groups = await adspower.getGroups();
    res.json({ success: true, data: groups });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/profiles', async (req, res) => {
  try {
    const profiles = await Profile.findAll();
    res.json({ success: true, data: profiles });
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
    // Ensure userAgent and operatingSystem are included in response
    const profileData = {
      ...profile,
      userAgent: profile.userAgent || profile.user_agent || '',
      operatingSystem: profile.operatingSystem || profile.os_type || ''
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
    console.log('Bulk create request received:', {
      profileAmount: req.body.profileAmount,
      profileGroup: req.body.profileGroup,
      proxyType: req.body.proxyType,
      proxiesCount: req.body.proxies?.length || 0,
      accountsCount: req.body.accounts?.length || 0
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
      note,
      deviceMemory,
      hardwareConcurrency,
      resolutionMode,
      screenResolution
    } = req.body;

    if (proxyType === 'custom' && (!Array.isArray(proxies) || proxies.length === 0)) {
      console.error('Validation failed: Proxies required for custom proxy type');
      return res.status(400).json({ 
        success: false, 
        error: 'Proxies are required when using custom proxy list' 
      });
    }

    console.log('Starting bulk profile creation...');
    const results = await orchestrator.runBulkProfileCreation(proxies || [], {
      accounts: accounts || [],
      profileName,
      profileAmount,
      profileGroup,
      operatingSystem,
      userAgent,
      note,
      proxyType: proxyType || 'noproxy',
      deviceMemory,
      hardwareConcurrency,
      resolutionMode,
      screenResolution
    });

    console.log('Bulk profile creation completed:', {
      total: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    });

    res.json({ 
      success: true, 
      data: {
        total: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results: results
      }
    });
  } catch (error) {
    console.error('Bulk profile creation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/profiles/:id/dna-analysis', async (req, res) => {
  try {
    const result = await orchestrator.runDNAAnalysis(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/profiles/:id/diagnostics', async (req, res) => {
  try {
    const result = await orchestrator.runQualityCheck(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/profiles/:id/farm', async (req, res) => {
  try {
    const result = await orchestrator.runFarming(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/campaigns/create', async (req, res) => {
  try {
    const { name, profileIds, action } = req.body;
    
    const results = [];
    for (const profileId of profileIds) {
      try {
        let result;
        if (action === 'farm') {
          result = await orchestrator.runFarming(profileId);
        } else if (action === 'diagnostics') {
          result = await orchestrator.runQualityCheck(profileId);
        } else if (action === 'dna') {
          result = await orchestrator.runDNAAnalysis(profileId);
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

const PORT = process.env.PORT || 3000;

export async function startDashboard() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Dashboard running on http://localhost:${PORT}`);
  });
}
