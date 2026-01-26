import { ProfileQueue } from './utils/queue.js';
import { DNAAnalysis } from './modules/dnaAnalysis.js';
import { Doctor } from './modules/doctor.js';
import { Farmer } from './modules/farmer.js';
import { Profile } from './models/Profile.js';
import { AdsPowerService } from './services/adspower.js';

export class AutomationOrchestrator {
  constructor(maxConcurrent = 10) {
    this.queue = new ProfileQueue(maxConcurrent);
    this.dnaAnalysis = new DNAAnalysis();
    this.doctor = new Doctor();
    this.farmer = new Farmer();
    this.adspower = new AdsPowerService();
  }

  async runDNAAnalysis(profileId) {
    return await this.queue.add(profileId, () => this.dnaAnalysis.analyzeProfile(profileId));
  }

  async runDiagnostics(profileId) {
    return await this.queue.add(profileId, () => this.doctor.runDiagnostics(profileId));
  }

  async runFarming(profileId) {
    return await this.queue.add(profileId, () => this.farmer.farmProfile(profileId));
  }

  async runIntakeProcess(profileData) {
    const { email, password, recoveryEmail, proxy, adspowerId } = profileData;

    let finalAdspowerId = adspowerId;

    try {
      if (!finalAdspowerId) {
        const profileDataForAdsPower = {
          name: email.split('@')[0],
          domain: 'com',
          group_id: '0'
        };

        if (proxy && proxy.host) {
          profileDataForAdsPower.user_proxy_config = {
            proxy_soft: 'other',
            proxy_type: 1,
            proxy_host: proxy.host,
            proxy_port: proxy.port,
            proxy_user: proxy.username || '',
            proxy_password: proxy.password || ''
          };
        } else {
          profileDataForAdsPower.proxy_type = 'noproxy';
        }

        const adspowerProfile = await this.adspower.createProfile(profileDataForAdsPower);
        finalAdspowerId = adspowerProfile.data?.user_id || adspowerProfile.data?.id || adspowerProfile.user_id;
        
        if (!finalAdspowerId) {
          console.error('AdsPower response:', JSON.stringify(adspowerProfile, null, 2));
          throw new Error(`Failed to create AdsPower profile. Response: ${JSON.stringify(adspowerProfile)}`);
        }
        
        console.log(`Profile created successfully with ID: ${finalAdspowerId}`);
      }

      const profile = new Profile({
        adspowerId: finalAdspowerId,
        email,
        password,
        recoveryEmail,
        proxy,
        status: 'intake'
      });

      await profile.save();

      const persona = await this.runDNAAnalysis(finalAdspowerId);
      
      await Profile.updateStatus(finalAdspowerId, 'ready');
      
      return { success: true, profileId: finalAdspowerId, persona };
    } catch (error) {
      if (finalAdspowerId) {
        await Profile.updateStatus(finalAdspowerId, 'error');
      }
      throw error;
    }
  }

  async runDailyFarming() {
    const profiles = await Profile.findAll({ 
      status: { $in: ['ready', 'needs_farming'] },
      networkError: false
    });

    const farmingPromises = profiles.map(profile => 
      this.runFarming(profile.adspowerId).catch(error => {
        console.error(`Farming failed for ${profile.adspowerId}:`, error);
        return { success: false, profileId: profile.adspowerId, error: error.message };
      })
    );

    const results = await Promise.allSettled(farmingPromises);
    return results.map(r => r.status === 'fulfilled' ? r.value : { success: false, error: r.reason });
  }

  async runQualityCheck(profileId) {
    return await this.runDiagnostics(profileId);
  }

  async runBulkProfileCreation(proxies, options = {}) {
    const { 
      accounts = [],
      profileName, 
      profileAmount, 
      profileGroup, 
      operatingSystem, 
      userAgent, 
      note,
      proxyType,
      deviceMemory,
      hardwareConcurrency,
      resolutionMode,
      screenResolution
    } = options;
    
    const count = profileAmount || (proxies.length > 0 ? proxies.length : 1);
    const results = [];
    
    console.log(`\n=== Starting bulk profile creation: ${count} profiles ===`);
    
    // Get available groups and determine which group_id to use
    let groupIdToUse = null;
    try {
      // Force refresh groups to get latest data (don't use cache when creating profiles)
      const groups = await this.adspower.getGroups(true);
      console.log(`  → Retrieved ${groups.length} group(s) from AdsPower`);
      
      // Normalize profileGroup - treat empty string as null
      const requestedGroupId = profileGroup && profileGroup.trim() !== '' ? profileGroup.trim() : null;
      
      if (requestedGroupId) {
        // User specified a group ID - try to find it
        const foundGroup = groups.find(g => {
          const gid = String(g.group_id || g.id || '');
          return gid === requestedGroupId || gid === String(requestedGroupId);
        });
        
        if (foundGroup) {
          groupIdToUse = foundGroup.group_id || foundGroup.id;
          console.log(`  → Using specified group: ${foundGroup.group_name || foundGroup.name} (ID: ${groupIdToUse})`);
        } else {
          console.log(`  ⚠ Warning: Specified Group ID "${requestedGroupId}" not found.`);
          console.log(`  → Available groups:`, groups.map(g => `${g.group_name || g.name} (${g.group_id || g.id})`).join(', ') || 'none');
          // If groups exist but requested one not found, use first available as fallback
          if (groups.length > 0) {
            groupIdToUse = groups[0].group_id || groups[0].id;
            console.log(`  → Falling back to first available group: ${groups[0].group_name || groups[0].name} (ID: ${groupIdToUse})`);
          }
        }
      } else {
        // No group specified by user - use first available if exists
        if (groups.length > 0) {
          groupIdToUse = groups[0].group_id || groups[0].id;
          console.log(`  → No group specified, using first available: ${groups[0].group_name || groups[0].name} (ID: ${groupIdToUse})`);
        }
      }
      
      // If no groups found in AdsPower, create a default group automatically
      if (!groupIdToUse) {
        console.log(`  ⚠ No groups found in AdsPower (retrieved ${groups.length} groups).`);
        console.log(`  → Creating default group automatically...`);
        try {
          const defaultGroup = await this.adspower.createGroup('Default Group');
          groupIdToUse = defaultGroup.group_id || defaultGroup.id;
          console.log(`  ✓ Successfully created default group: ${defaultGroup.group_name || 'Default Group'} (ID: ${groupIdToUse})`);
          
          // Invalidate cache so next call gets the new group
          this.adspower.groupsCache = null;
          this.adspower.groupsCacheTime = null;
        } catch (createError) {
          console.error(`  ✗ Failed to create default group: ${createError.message}`);
          console.error(`  → Error details:`, createError);
          throw new Error(`No groups found in AdsPower and failed to create default group: ${createError.message}. Please create at least one group manually in AdsPower first.`);
        }
      }
    } catch (error) {
      console.error('  ✗ Error handling groups:', error.message);
      throw new Error(`Failed to get/create groups: ${error.message}`);
    }
    
    for (let i = 0; i < count; i++) {
      const name = profileName ? `${profileName}-${i + 1}` : `Profile-${i + 1}`;
      const account = accounts && accounts[i] ? accounts[i] : null;
      // Use proxy from account if available (2FA format), otherwise use separate proxy list
      const proxy = account?.proxy || (proxies && proxies[i] ? proxies[i] : null);
      
      console.log(`\n[${i + 1}/${count}] Creating profile: ${name}`);
      console.log(`  → Group ID to use: ${groupIdToUse || 'NOT SET'}`);
      console.log(`  → Proxy: ${proxy ? `${proxy.host}:${proxy.port}` : 'None'}`);
      console.log(`  → Account: ${account ? account.email || 'No email' : 'None'}`);
      console.log(`  → Account parsed data:`, {
        email: account?.email || 'N/A',
        hasPassword: !!account?.password,
        hasRecoveryEmail: !!account?.recoveryEmail,
        hasTotpSecret: !!account?.totpSecret,
        totpSecretLength: account?.totpSecret?.length || 0,
        totpSecretPreview: account?.totpSecret ? `${account.totpSecret.substring(0, 10)}...` : 'N/A',
        hasProxy: !!account?.proxy
      });
      console.log(`  → 2FA: ${account?.totpSecret ? `Yes (TOTP secret: ${account.totpSecret.substring(0, 10)}...)` : 'No'}`);
      
      try {
        // Reduced delay: 5s for first profile, 10-15s for subsequent ones
        const delay = i === 0 ? 5000 : 10000 + Math.random() * 5000;
        console.log(`  → Waiting ${Math.round(delay)}ms (${Math.round(delay/1000)}s) before creating profile...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        console.log(`  → Creating AdsPower profile...`);
        
        const profileData = {
          name: name,
          domain: 'com',
          group_id: groupIdToUse
        };

        if (proxyType === 'custom' && proxy && proxy.host) {
          profileData.user_proxy_config = {
            proxy_soft: 'other',
            proxy_type: 'http',
            proxy_host: proxy.host,
            proxy_port: proxy.port || '8080',
            proxy_user: proxy.username || '',
            proxy_password: proxy.password || ''
          };
        } else {
          profileData.proxy_type = 'noproxy';
        }

        if (operatingSystem) {
          profileData.os_type = operatingSystem;
        }

        if (userAgent) {
          profileData.user_agent = userAgent;
        }

        if (deviceMemory) {
          profileData.device_memory = deviceMemory;
        }

        if (hardwareConcurrency) {
          profileData.hardware_concurrency = hardwareConcurrency;
        }

        if (resolutionMode === 'specific' && screenResolution) {
          const [width, height] = screenResolution.split('x');
          profileData.screen_resolution = {
            width: parseInt(width),
            height: parseInt(height)
          };
        } else if (resolutionMode === 'random') {
          profileData.screen_resolution = 'random';
        }

        if (note) {
          profileData.notes = note;
        }

        const adspowerProfile = await this.adspower.createProfile(profileData);
        console.log('  → AdsPower response structure:', JSON.stringify(adspowerProfile, null, 2));
        
        // Try multiple possible locations for the profile ID
        const adspowerId = adspowerProfile?.data?.user_id || 
                          adspowerProfile?.data?.id || 
                          adspowerProfile?.data?.profile_id ||
                          adspowerProfile?.data?.browser_id ||
                          adspowerProfile?.user_id ||
                          adspowerProfile?.id ||
                          adspowerProfile?.profile_id ||
                          adspowerProfile?.browser_id;
        
        if (!adspowerId) {
          console.error('  ✗ Could not find profile ID in response. Full response:', JSON.stringify(adspowerProfile, null, 2));
          throw new Error('Failed to get profile ID from AdsPower');
        }
        
        console.log(`  ✓ Profile ID extracted: ${adspowerId}`);

        const profile = new Profile({
          adspowerId: adspowerId,
          email: account?.email || '',
          password: account?.password || '',
          recoveryEmail: account?.recoveryEmail || '',
          totpSecret: account?.totpSecret || '',
          proxy: proxy,
          status: 'ready',
          notes: note || '',
          groupId: groupIdToUse || '0',
          userAgent: userAgent || '',
          operatingSystem: operatingSystem || ''
        });

        console.log(`  → Profile object before save:`, {
          email: profile.email,
          hasPassword: !!profile.password,
          hasRecoveryEmail: !!profile.recoveryEmail,
          hasTotpSecret: !!profile.totpSecret,
          totpSecretLength: profile.totpSecret?.length || 0,
          totpSecretPreview: profile.totpSecret ? `${profile.totpSecret.substring(0, 10)}...` : 'N/A',
          hasProxy: !!profile.proxy,
          userAgent: profile.userAgent || 'N/A',
          operatingSystem: profile.operatingSystem || 'N/A'
        });

        await profile.save();
        
        // Verify the profile was saved correctly
        const savedProfile = await Profile.findById(adspowerId);
        console.log(`  → Profile after save verification:`, {
          email: savedProfile?.email || 'N/A',
          userAgent: savedProfile?.userAgent || savedProfile?.user_agent || 'N/A',
          operatingSystem: savedProfile?.operatingSystem || savedProfile?.os_type || 'N/A',
          hasTotpSecret: !!savedProfile?.totpSecret,
          totpSecretLength: savedProfile?.totpSecret?.length || 0
        });
        
        console.log(`  ✓ Profile created successfully! ID: ${adspowerId}`);
        results.push({ success: true, index: i, profileId: adspowerId, name: name });
      } catch (error) {
        console.error(`  ✗ Failed to create profile: ${error.message}`);
        console.error(`  Error details:`, error);
        
        results.push({ 
          success: false, 
          index: i, 
          name: name,
          error: error.message 
        });
        
        if (error.message.includes('Rate limit') || error.message.includes('ADSPOWER_COOLDOWN')) {
          const waitTime = 60000 + Math.random() * 30000;
          console.log(`  → Rate limit hit, waiting ${Math.round(waitTime)}ms (${Math.round(waitTime/1000)}s) before continuing...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    console.log(`\n=== Bulk creation complete: ${results.filter(r => r.success).length}/${results.length} succeeded ===\n`);
    return results;
  }

  getQueueStatus() {
    return this.queue.getStatus();
  }
}
