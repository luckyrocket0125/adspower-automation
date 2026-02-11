import { ProfileQueue } from './utils/queue.js';
import { DNAAnalysis } from './modules/dnaAnalysis.js';
import { Doctor } from './modules/doctor.js';
import { Farmer } from './modules/farmer.js';
import { Profile } from './models/Profile.js';
import { AdsPowerService } from './services/adspower.js';

export class AutomationOrchestrator {
  constructor(maxConcurrent = 3) {
    this.queue = new ProfileQueue(maxConcurrent);
    this.dnaAnalysis = new DNAAnalysis();
    this.doctor = new Doctor();
    this.farmer = new Farmer();
    this.adspower = new AdsPowerService();
  }

  async runDNAAnalysis(profileId, options = {}) {
    return await this.queue.add(profileId, () => this.dnaAnalysis.analyzeProfile(profileId, options));
  }

  async runDiagnostics(profileId, options = {}) {
    return await this.queue.add(profileId, () => this.doctor.runDiagnostics(profileId, options));
  }

  async runFarming(profileId, options = {}) {
    return await this.queue.add(profileId, () => this.farmer.farmProfile(profileId, options));
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

  async runQualityCheck(profileId, options = {}) {
    return await this.runDiagnostics(profileId, options);
  }

  async runBulkProfileCreation(proxies, options = {}, progressCallback = null) {
    let { 
      accounts = [],
      profileName, 
      profileAmount, 
      profileGroup, 
      operatingSystem, 
      userAgent,
      proxyType,
      deviceMemory,
      hardwareConcurrency,
      resolutionMode,
      screenResolution
    } = options;
    
    // Prevent Android/iOS selection (not supported for automation)
    if (operatingSystem && (operatingSystem.toLowerCase().includes('android') || operatingSystem.toLowerCase().includes('ios'))) {
      console.log('⚠ Warning: Android/iOS not supported, defaulting to Windows');
      operatingSystem = 'windows';
    }
    
    const count = profileAmount || (proxies.length > 0 ? proxies.length : 1);
    const results = [];
    let successful = 0;
    let failed = 0;
    
    console.log(`\n=== Starting bulk profile creation: ${count} profiles ===`);
    
    // Determine which group_id to use
    // IMPORTANT: If the UI provided a group id, trust it even if AdsPower group-list temporarily fails.
    const requestedGroupId = profileGroup && profileGroup.trim() !== '' ? profileGroup.trim() : null;
    let groupIdToUse = requestedGroupId;
    try {
      if (!groupIdToUse) {
        // No group specified by user, try to pick the first available
        const groups = await this.adspower.getGroups(true);
        console.log(`  → Retrieved ${groups.length} group(s) from AdsPower`);
        if (groups.length > 0) {
          groupIdToUse = groups[0].group_id || groups[0].id;
          console.log(`  → No group specified, using first available: ${groups[0].group_name || groups[0].name} (ID: ${groupIdToUse})`);
        }
      }
    } catch (error) {
      console.error('  ⚠ Failed to fetch groups from AdsPower:', error.message);
      // Continue if user provided groupId; otherwise we will error below.
    }

    if (!groupIdToUse) {
      throw new Error('No groups found in AdsPower. Please create and select a group using the "Create Group" button before creating profiles.');
    }
    
    for (let i = 0; i < count; i++) {
      const name = profileName ? `${profileName}-${i + 1}` : `Profile-${i + 1}`;
      const account = accounts && accounts[i] ? accounts[i] : null;
      // Use proxy from account if available (2FA format), otherwise use separate proxy list
      const proxy = account?.proxy || (proxies && proxies[i] ? proxies[i] : null);
      
      if (progressCallback) {
        progressCallback({
          current: i,
          total: count,
          successful: results.filter(r => r.success).length,
          failed: results.filter(r => !r.success).length,
          message: { type: 'info', text: `Creating profile ${i + 1}/${count}: ${name}` }
        });
      }
      
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
        console.log(`  → Operating System from options: "${operatingSystem}"`);
        
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

        // Set OS via fingerprint_config.random_ua.ua_system_version
        // According to AdsPower API v2, OS is set via fingerprint_config.random_ua.ua_system_version array
        // Valid values: ["Windows"], ["Mac OS X"] or ["macOS"], ["Linux"]
        // Note: AdsPower might require "Mac OS X" instead of "macOS"
        
        // If no OS specified, randomize among Windows, Mac OS X, and Linux
        let osToUse = operatingSystem;
        if (!osToUse || osToUse.trim() === '') {
          const randomOS = ['windows', 'macos', 'linux'][Math.floor(Math.random() * 3)];
          osToUse = randomOS;
          console.log(`  → No OS specified, randomized to: "${osToUse}"`);
        }
        
        console.log(`  → Processing OS: "${osToUse}"`);
        
        // Initialize fingerprint_config if not exists
        if (!profileData.fingerprint_config) {
          profileData.fingerprint_config = {};
        }
        if (!profileData.fingerprint_config.random_ua) {
          profileData.fingerprint_config.random_ua = {};
        }
        
        // Ensure Android/iOS are not used (not supported for automation)
        const osLower = osToUse.toLowerCase();
        if (osLower.includes('android') || osLower.includes('ios')) {
          console.log(`⚠ Warning: Android/iOS not supported, defaulting to Windows for profile ${name}`);
          profileData.fingerprint_config.random_ua.ua_system_version = ['Windows'];
        } else {
          // Map our OS values to AdsPower API values
          // AdsPower might require "Mac OS X" instead of "macOS" for UA matching
          if (osLower === 'macos' || osLower === 'mac') {
            // Try "Mac OS X" first (more likely to match), fallback to "macOS"
            profileData.fingerprint_config.random_ua.ua_system_version = ['Mac OS X'];
            console.log(`  → Mapped "${osToUse}" to AdsPower ua_system_version: ["Mac OS X"]`);
          } else if (osLower === 'windows') {
            profileData.fingerprint_config.random_ua.ua_system_version = ['Windows'];
            console.log(`  → Using ua_system_version: ["Windows"]`);
          } else if (osLower === 'linux') {
            profileData.fingerprint_config.random_ua.ua_system_version = ['Linux'];
            console.log(`  → Using ua_system_version: ["Linux"]`);
          } else {
            // Unknown OS, randomize among the 3 options
            const randomOS = ['Windows', 'Mac OS X', 'Linux'][Math.floor(Math.random() * 3)];
            profileData.fingerprint_config.random_ua.ua_system_version = [randomOS];
            console.log(`⚠ Warning: Unknown OS type "${osToUse}", randomized to: ${randomOS}`);
          }
        }
        
        // Use ua_auto = smart match latest kernel (e.g. Chrome 143 when released) per AdsPower API
        profileData.fingerprint_config.browser_kernel_config = {
          version: 'ua_auto',
          type: 'chrome'
        };

        // WebRTC: use proxy IP so the browser looks real (disabled = no IP = suspicious)
        profileData.fingerprint_config.webrtc = proxy && proxy.host ? 'proxy' : 'local';
        // Location: block so scripts don't break on permission prompts; low footprint
        profileData.fingerprint_config.location = 'block';
        
        console.log(`  → Final fingerprint_config.random_ua.ua_system_version:`, profileData.fingerprint_config.random_ua.ua_system_version);
        console.log(`  → Full profileData being sent:`, JSON.stringify(profileData, null, 2));

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

        // Get the final OS that was used (after randomization if needed)
        const finalOS = profileData.fingerprint_config?.random_ua?.ua_system_version?.[0] || operatingSystem || 'windows';
        const finalOSMapped = finalOS === 'Mac OS X' ? 'macos' : finalOS.toLowerCase();
        
        const profile = new Profile({
          adspowerId: adspowerId,
          email: account?.email || '',
          password: account?.password || '',
          recoveryEmail: account?.recoveryEmail || '',
          totpSecret: account?.totpSecret || '',
          proxy: proxy,
          status: 'ready',
          notes: '',
          groupId: groupIdToUse || '0',
          userAgent: userAgent || '',
          operatingSystem: finalOSMapped
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
        
        // Update browser kernel to latest version after profile creation
        // (Sometimes the browser kernel config during creation doesn't apply, so we update it explicitly)
        try {
          await this.adspower.updateProfileBrowserKernel(adspowerId);
          console.log(`  ✓ Browser kernel updated to latest version`);
        } catch (kernelError) {
          console.warn(`  ⚠ Could not update browser kernel: ${kernelError.message}`);
        }
        
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
        successful++;
        results.push({ success: true, index: i, profileId: adspowerId, name: name });
        
        if (progressCallback) {
          progressCallback({
            current: i + 1,
            total: count,
            successful,
            failed,
            message: { type: 'success', text: `Profile ${i + 1}/${count} created: ${name} (ID: ${adspowerId})` }
          });
        }
      } catch (error) {
        console.error(`  ✗ Failed to create profile: ${error.message}`);
        console.error(`  Error details:`, error);
        failed++;
        
        results.push({ 
          success: false, 
          index: i, 
          name: name,
          error: error.message 
        });
        
        if (progressCallback) {
          progressCallback({
            current: i + 1,
            total: count,
            successful,
            failed,
            message: { type: 'error', text: `Profile ${i + 1}/${count} failed: ${name} - ${error.message}` }
          });
        }
        
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
