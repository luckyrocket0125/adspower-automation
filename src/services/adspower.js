import puppeteer from 'puppeteer-core';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const ADSPOWER_API_URL = process.env.ADSPOWER_API_URL || 'http://local.adspower.net:50325';
const ADSPOWER_API_KEY = process.env.ADSPOWER_API_KEY || '';

export class AdsPowerService {
  constructor() {
    this.apiUrl = ADSPOWER_API_URL;
    this.apiKey = ADSPOWER_API_KEY;
    this.groupsCache = null;
    this.groupsCacheTime = null;
    this.groupsCacheTTL = 30000; // Cache for 30 seconds
    this.lastGroupsCall = 0;
    this.groupsCallMinInterval = 2000; // Minimum 2 seconds between calls
    this.lastStartProfileCall = 0;
    this.startProfileMinInterval = 1500; // Minimum 1.5 seconds between start profile calls
    this.lastProfileListV2Call = 0;
    this.profileListV2MinInterval = 2500; // Minimum 2.5s between list V2 calls to avoid "Too many request"
  }

  async createProfile(profileData) {
    const url = `${this.apiUrl}/api/v2/browser-profile/create`;

    if (!this.apiKey || this.apiKey.trim() === '') {
      console.error('ERROR: ADSPOWER_API_KEY is missing or empty!');
      console.error('Please add ADSPOWER_API_KEY=your_key_here to your .env file');
      throw new Error('ADSPOWER_API_KEY is required. Please set it in your .env file. Get it from AdsPower: Automation → API');
    }

    // Rate limiting: wait before profile creation to avoid hitting AdsPower rate limits
    // Reduced from 120s to 5s for better user experience
    const waitTime = 5000; // 5 seconds
    console.log(`Waiting ${waitTime/1000}s before profile creation to avoid rate limits...`);
    await new Promise(r => setTimeout(r, waitTime));

    try {
      console.log('Trying endpoint:', url);
      console.log('API Key length:', this.apiKey.length);
      console.log('API Key first 10 chars:', this.apiKey.substring(0, 10) + '...');
      console.log('Profile data:', JSON.stringify(profileData, null, 2));
      console.log('Group ID in request:', profileData.group_id || 'NOT SET');

      const headers = { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'api-key': this.apiKey,
        'Api-Key': this.apiKey,
        'X-API-Key': this.apiKey
      };

      const requestData = { 
        ...profileData,
        api_key: this.apiKey
      };

      const response = await axios.post(url, requestData, {
        timeout: 15000,
        headers: headers,
        params: { api_key: this.apiKey }
      });

      if (response.data?.code === -1 &&
          response.data?.msg?.toLowerCase().includes('rate')) {
        console.error('AdsPower hard rate-limit detected');
        throw new Error('ADSPOWER_COOLDOWN');
      }

      if (response.data?.code !== 0) {
        const errorMsg = response.data.msg || 'Unknown error';
        if (errorMsg.toLowerCase().includes('group is deleted') || 
            errorMsg.toLowerCase().includes('group is archived')) {
          throw new Error('INVALID_GROUP_ID');
        }
        throw new Error(
          `AdsPower API error (${response.data.code}): ${errorMsg}`
        );
      }

      console.log('Profile created successfully');
      console.log('Full response data:', JSON.stringify(response.data, null, 2));
      return response.data;

    } catch (err) {
      if (err.message === 'ADSPOWER_COOLDOWN') {
        console.error(`
          AdsPower entered cooldown mode.
          STOP all profile creation.
          Wait 5 minutes.
          Restart AdsPower desktop.
        `);
        process.exit(1);
      }

      throw err;
    }
  }

  async getGroups(forceRefresh = false) {
    // Check cache first
    const now = Date.now();
    if (!forceRefresh && this.groupsCache && this.groupsCacheTime && 
        (now - this.groupsCacheTime) < this.groupsCacheTTL) {
      console.log(`Returning cached groups data (${this.groupsCache.length} groups)`);
      return this.groupsCache;
    }
    
    if (forceRefresh) {
      console.log('Force refresh requested, clearing cache');
      this.groupsCache = null;
      this.groupsCacheTime = null;
    }
    
    // Rate limiting: ensure minimum interval between calls
    const timeSinceLastCall = now - this.lastGroupsCall;
    if (timeSinceLastCall < this.groupsCallMinInterval) {
      const waitTime = this.groupsCallMinInterval - timeSinceLastCall;
      console.log(`Rate limiting: waiting ${waitTime}ms before next groups API call...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastGroupsCall = Date.now();
    
    try {
      const params = this.apiKey ? { api_key: this.apiKey } : {};
      const headers = this.apiKey ? { 
        'api-key': this.apiKey,
        'Api-Key': this.apiKey,
        'X-API-Key': this.apiKey,
        'Authorization': `Bearer ${this.apiKey}`
      } : {};
      
      // Try v1 endpoint first
      let response;
      try {
        response = await axios.get(`${this.apiUrl}/api/v1/group/list`, {
          params: { ...params, page_size: 1000, page: 1 },
          headers: headers,
          timeout: 10000
        });
      } catch (v1Error) {
        // If v1 fails, try v2
        console.log('v1 group/list failed, trying v2...');
        try {
          response = await axios.get(`${this.apiUrl}/api/v2/group/list`, {
            params: { ...params, page_size: 1000, page: 1 },
            headers: headers,
            timeout: 10000
          });
        } catch (v2Error) {
          // Both v1 and v2 failed
          console.error('Both v1 and v2 group/list endpoints failed');
          console.error('v1 error:', v1Error.message);
          console.error('v2 error:', v2Error.message);
          if (v2Error.response) {
            console.error('v2 response status:', v2Error.response.status);
            console.error('v2 response data:', JSON.stringify(v2Error.response.data, null, 2));
          }
          // Check if AdsPower is accessible
          if (v2Error.code === 'ECONNREFUSED' || v2Error.code === 'ETIMEDOUT' || v2Error.response?.status === 404) {
            console.error('⚠ AdsPower API appears to be unavailable. Please check:');
            console.error('  1. Is AdsPower desktop application running?');
            console.error(`  2. Is the API URL correct? (Current: ${this.apiUrl})`);
            console.error('  3. Check your .env file for ADSPOWER_API_URL and ADSPOWER_API_KEY');
            // If we have cached data, return it instead of throwing
            if (this.groupsCache) {
              console.log('Returning cached groups due to API unavailability');
              return this.groupsCache;
            }
            // Return empty array instead of throwing for 404/connection errors
            console.log('No cached groups available, returning empty array');
            return [];
          }
          // For other errors, re-throw to be caught by outer catch
          throw v2Error;
        }
      }
      
      console.log('Groups API response:', JSON.stringify(response.data, null, 2));
      
      // Check response structure
      if (response.data?.code === 0) {
        // v1 format: response.data.data.list
        if (response.data?.data?.list) {
          const groups = response.data.data.list;
          console.log(`✓ Found ${groups.length} groups:`, groups.map(g => `${g.group_name || g.name} (ID: ${g.group_id || g.id})`).join(', '));
          if (groups.length === 0) {
            console.warn('⚠ Warning: API returned 0 groups, but you mentioned there are 2 groups in AdsPower');
          }
          // Cache the result
          this.groupsCache = groups;
          this.groupsCacheTime = Date.now();
          return groups;
        }
        // v2 format might be different
        if (response.data?.data) {
          const groups = Array.isArray(response.data.data) ? response.data.data : (response.data.data.list || []);
          console.log(`✓ Found ${groups.length} groups:`, groups.map(g => `${g.group_name || g.name} (ID: ${g.group_id || g.id})`).join(', '));
          if (groups.length === 0) {
            console.warn('⚠ Warning: API returned 0 groups, but you mentioned there are 2 groups in AdsPower');
          }
          // Cache the result
          this.groupsCache = groups;
          this.groupsCacheTime = Date.now();
          return groups;
        }
        
        // Check for other possible response structures
        console.warn('⚠ Unexpected response structure. Full response:', JSON.stringify(response.data, null, 2));
      }
      
      // If code is not 0, log the error message
      if (response.data?.code !== undefined && response.data?.code !== 0) {
        const errorMsg = response.data?.msg || response.data?.message || 'Unknown error';
        console.error('Groups API returned error:', errorMsg);
        console.error('Full response:', JSON.stringify(response.data, null, 2));
        
        // If rate limited, return cached data if available
        if (errorMsg.toLowerCase().includes('too many request') || 
            errorMsg.toLowerCase().includes('rate limit')) {
          console.log('Rate limit detected, returning cached groups if available');
          if (this.groupsCache) {
            return this.groupsCache;
          }
          // Wait a bit and return empty array
          console.log('No cached data available, returning empty array');
          return [];
        }
      }
      
      console.log('No groups found in response, returning empty array');
      const emptyResult = [];
      // Cache empty result too (but with shorter TTL)
      this.groupsCache = emptyResult;
      this.groupsCacheTime = Date.now();
      return emptyResult;
    } catch (error) {
      console.error('Error fetching groups:', error.message);
      if (error.response?.data) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', JSON.stringify(error.response.data, null, 2));
        
        // Check if it's a rate limit error
        const errorMsg = error.response.data?.msg || error.response.data?.message || '';
        if (errorMsg.toLowerCase().includes('too many request') || 
            errorMsg.toLowerCase().includes('rate limit')) {
          console.log('Rate limit detected in error response, returning cached groups if available');
          if (this.groupsCache) {
            return this.groupsCache;
          }
        }
      }
      
      // If we have cached data, return it even on error
      if (this.groupsCache) {
        console.log('Returning cached groups due to error');
        return this.groupsCache;
      }
      
      // Don't throw - return empty array so UI can show "no groups found" message
      return [];
    }
  }

  async createGroup(groupName = 'Default Group') {
    if (!this.apiKey || this.apiKey.trim() === '') {
      console.error('ERROR: ADSPOWER_API_KEY is missing or empty!');
      console.error('Please add ADSPOWER_API_KEY=your_key_here to your .env file');
      throw new Error('ADSPOWER_API_KEY is required. Please set it in your .env file. Get it from AdsPower: Automation → API');
    }

    try {
      const headers = { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'api-key': this.apiKey,
        'Api-Key': this.apiKey,
        'X-API-Key': this.apiKey
      };
      
      const requestData = {
        group_name: groupName,
        api_key: this.apiKey
      };
      
      // Try v1 endpoint first
      let response;
      try {
        response = await axios.post(`${this.apiUrl}/api/v1/group/create`, requestData, {
          timeout: 15000,
          headers: headers,
          params: { api_key: this.apiKey }
        });
      } catch (err) {
        // If v1 fails, try v2
        response = await axios.post(`${this.apiUrl}/api/v2/group/create`, requestData, {
          timeout: 15000,
          headers: headers,
          params: { api_key: this.apiKey }
        });
      }
      
      if (response.data?.code !== 0) {
        throw new Error(response.data?.msg || 'Failed to create group');
      }
      
      const groupId = response.data.data?.group_id || response.data.data?.id;
      if (!groupId) {
        throw new Error('Failed to get group ID from response');
      }
      
      console.log(`✓ Group created successfully: ${groupName} (ID: ${groupId})`);
      
      // Invalidate groups cache since we just created a new group
      this.groupsCache = null;
      this.groupsCacheTime = null;
      console.log('Groups cache invalidated after creating new group');
      
      return { group_id: groupId, group_name: groupName };
    } catch (error) {
      console.error('Error creating group:', error.message);
      throw error;
    }
  }

  /**
   * Get user agent from AdsPower using dedicated UA endpoint
   * @param {string|string[]} profileId - Single profile ID or array of profile IDs (max 10)
   * @returns {Promise<string|null>} User agent string or null if not found
   */
  async getUserAgent(profileId) {
    if (!this.apiKey || this.apiKey.trim() === '') {
      return null;
    }

    try {
      const profileIds = Array.isArray(profileId) ? profileId : [profileId];
      
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'api-key': this.apiKey,
        'Api-Key': this.apiKey,
        'X-API-Key': this.apiKey
      };

      const requestBody = {
        profile_id: profileIds
      };

      const response = await axios.post(`${this.apiUrl}/api/v2/browser-profile/ua`, requestBody, {
        timeout: 10000,
        headers
      });

      if (response.data?.code === 0 && response.data?.data) {
        const data = response.data.data;
        console.log(`getUserAgent response for profile ${profileIds[0]}:`, JSON.stringify(data, null, 2));
        
        // Response structure: { "list": [{ "profile_id": "...", "ua": "..." }] }
        let list = null;
        if (data.list && Array.isArray(data.list)) {
          list = data.list;
        } else if (Array.isArray(data)) {
          list = data;
        } else if (typeof data === 'object') {
          // Try to find list in nested structure
          list = data.list || Object.values(data).find(v => Array.isArray(v)) || null;
        }
        
        if (list && Array.isArray(list) && list.length > 0) {
          // Find the entry matching our profile ID
          const profileIdStr = String(profileIds[0]);
          const entry = list.find(item => 
            item && (
              String(item.profile_id) === profileIdStr || 
              String(item.user_id) === profileIdStr ||
              String(item.profile_no) === profileIdStr
            )
          ) || list[0]; // Fallback to first entry if not found
          
          const ua = entry?.ua || entry?.user_agent || entry?.userAgent || null;
          if (ua) {
            console.log(`✓ Found user agent: ${ua.substring(0, 50)}...`);
            return ua;
          }
        } else if (typeof data === 'object' && !Array.isArray(data)) {
          // If it's an object with profile_id as key
          const profileIdStr = String(profileIds[0]);
          let entry = data[profileIdStr];
          
          // If not found by exact ID, try to find by any key
          if (!entry) {
            entry = Object.values(data).find(item => 
              item && (item.profile_id === profileIdStr || item.user_id === profileIdStr)
            ) || Object.values(data)[0];
          }
          
          if (entry) {
            const ua = entry.ua || entry.user_agent || entry.userAgent || null;
            if (ua) {
              console.log(`✓ Found user agent from object response: ${ua.substring(0, 50)}...`);
              return ua;
            }
          }
        }
      } else {
        console.log(`getUserAgent API returned code ${response.data?.code}: ${response.data?.msg || 'Unknown error'}`);
      }
      
      console.log(`⚠ User agent not found in response for profile ${profileIds[0]}`);
      return null;
    } catch (error) {
      console.warn(`Could not get user agent for profile ${profileId}:`, error.message);
      return null;
    }
  }

  /**
   * Extract user agent from AdsPower profile data (checks all possible locations)
   * @deprecated Use getUserAgent() instead for more reliable results
   */
  extractUserAgent(profileData) {
    if (!profileData) return null;
    
    // Check top-level fields
    if (profileData.user_agent) return profileData.user_agent;
    if (profileData.userAgent) return profileData.userAgent;
    
    // Check fingerprint_config
    const fp = profileData.fingerprint_config || {};
    
    // Check fingerprint_config top-level
    if (fp.user_agent) return fp.user_agent;
    if (fp.userAgent) return fp.userAgent;
    if (fp.ua) return fp.ua;
    
    // Check fingerprint_config.random_ua
    const randomUa = fp.random_ua || {};
    if (randomUa.ua) return randomUa.ua;
    if (randomUa.user_agent) return randomUa.user_agent;
    if (randomUa.userAgent) return randomUa.userAgent;
    
    // Check fingerprint_config.ua_config
    const uaConfig = fp.ua_config || {};
    if (uaConfig.ua) return uaConfig.ua;
    if (uaConfig.user_agent) return uaConfig.user_agent;
    
    // Check if user agent might be in browser_kernel_config or other nested locations
    const browserKernel = fp.browser_kernel_config || {};
    if (browserKernel.ua) return browserKernel.ua;
    if (browserKernel.user_agent) return browserKernel.user_agent;
    
    return null;
  }

  /**
   * Get profile list from V2 API (same "Name" as AdsPower app).
   * Pass page/limit in body (POST). Returns { list: [{ profile_id, name, ... }], page, limit } or throws.
   */
  async getProfileListV2(page = 1, limit = 100) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'api-key': this.apiKey,
      'Api-Key': this.apiKey,
      'X-API-Key': this.apiKey
    };
    const params = this.apiKey ? { api_key: this.apiKey } : {};
    const body = { page, limit };
    const minInterval = this.profileListV2MinInterval;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const now = Date.now();
        const elapsed = now - this.lastProfileListV2Call;
        if (elapsed < minInterval && this.lastProfileListV2Call > 0) {
          await new Promise(r => setTimeout(r, minInterval - elapsed));
        }
        this.lastProfileListV2Call = Date.now();

        const response = await axios.post(`${this.apiUrl}/api/v2/browser-profile/list`, body, {
          timeout: 30000, // Increased from 15s to 30s
          headers,
          params
        });
        if (response.data?.code !== 0 && response.data?.code !== undefined) {
          const msg = (response.data?.msg || '').toLowerCase();
          if ((msg.includes('too many') || msg.includes('rate')) && attempt < maxRetries) {
            console.warn(`Profile list V2 rate limited, waiting 5s before retry ${attempt + 1}/${maxRetries}...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          throw new Error(response.data?.msg || 'V2 list failed');
        }
        return response.data?.data || { list: [], page: 1, limit };
      } catch (error) {
        const msg = (error.response?.data?.msg || error.message || '').toLowerCase();
        if ((msg.includes('too many') || msg.includes('rate')) && attempt < maxRetries) {
          console.warn(`Profile list V2 rate limited: ${error.message}, waiting 5s before retry ${attempt + 1}/${maxRetries}...`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        // Check for timeout
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          console.error('Error fetching profile list V2: Request timeout (30s exceeded)');
          console.error('⚠ AdsPower API is taking too long to respond. Possible causes:');
          console.error('  1. AdsPower desktop application may be slow or overloaded');
          console.error('  2. Too many profiles in AdsPower (try reducing limit)');
          console.error(`  3. Network connectivity issues (API URL: ${this.apiUrl})`);
          if (attempt < maxRetries) {
            console.warn(`Retrying profile list V2 (attempt ${attempt + 1}/${maxRetries})...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
        }
        console.error('Error fetching profile list V2:', error.message);
        if (error.response) {
          console.error('Response status:', error.response.status);
          console.error('Response data:', JSON.stringify(error.response.data, null, 2));
        }
        throw error;
      }
    }
    throw new Error('Profile list V2 failed after retries');
  }

  async getProfileList() {
    try {
      const params = this.apiKey ? { api_key: this.apiKey } : {};
      const headers = this.apiKey ? { 'api-key': this.apiKey } : {};

      const response = await axios.get(`${this.apiUrl}/api/v1/user/list`, {
        params: params,
        headers: headers
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching profile list:', error.message);
      throw error;
    }
  }

  async getProfileDetails(profileId) {
    try {
      if (!this.apiKey || this.apiKey.trim() === '') {
        throw new Error('ADSPOWER_API_KEY is required');
      }

      const headers = {
        'Authorization': `Bearer ${this.apiKey}`,
        'api-key': this.apiKey,
        'Api-Key': this.apiKey,
        'X-API-Key': this.apiKey
      };

      // Try to get profile from list: V1 list first, then V2 list (profiles created via V2 may only be in V2 list)
      const matchId = (p) =>
        p.user_id === profileId || p.profile_id === profileId || p.id === profileId ||
        String(p.user_id) === String(profileId) || String(p.profile_id) === String(profileId);
      try {
        const listResponse = await this.getProfileList();
        if (listResponse?.data?.list) {
          const profile = listResponse.data.list.find(matchId);
          if (profile) return { data: profile, code: 0 };
        }
      } catch (_) {}
      try {
        const v2List = await this.getProfileListV2(1, 100);
        const list = v2List?.list || [];
        const profile = list.find(matchId);
        if (profile) return { data: profile, code: 0 };
      } catch (_) {}

      // Try v2 endpoint first, then fallback to v1
      let response;
      try {
        const v2Params = {
          profile_id: profileId,
          api_key: this.apiKey
        };
        response = await axios.get(`${this.apiUrl}/api/v2/browser-profile/detail`, {
          timeout: 15000,
          headers: headers,
          params: v2Params
        });
        if (response.data?.code === 0) {
          return response.data;
        }
      } catch (v2Error) {
        // Continue to v1 fallback
      }

      // Fallback to v1 endpoint
      try {
        const v1Params = {
          user_id: profileId,
          api_key: this.apiKey
        };
        response = await axios.get(`${this.apiUrl}/api/v1/user/detail`, {
          timeout: 15000,
          headers: headers,
          params: v1Params
        });
        if (response.data?.code === 0) {
          return response.data;
        }
      } catch (v1Error) {
        // Both endpoints failed
        throw new Error(`Profile ${profileId} not found in AdsPower`);
      }

      if (response.data?.code !== 0 && response.data?.code !== undefined) {
        throw new Error(response.data?.msg || 'Failed to get profile details');
      }

      return response.data;
    } catch (error) {
      // Don't log 404 errors as errors - they're expected if profile doesn't exist
      if (error.response?.status === 404 || error.message?.includes('not found')) {
        throw error; // Re-throw but don't log as error
      }
      throw error;
    }
  }

  /**
   * Update a profile's browser kernel to latest (e.g. Chrome 143 when available).
   * Uses AdsPower Update Profile V2 with fingerprint_config.browser_kernel_config.
   * Call before startProfile so existing profiles use the latest browser.
   */
  async updateProfileBrowserKernel(profileId) {
    if (!this.apiKey || this.apiKey.trim() === '') return;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'api-key': this.apiKey,
      'Api-Key': this.apiKey,
      'X-API-Key': this.apiKey
    };
    try {
      // Try with profile_id as string first (V2 format)
      // Only update browser_kernel_config to avoid overwriting other fingerprint settings
      const body = {
        profile_id: profileId,
        api_key: this.apiKey,
        fingerprint_config: {
          browser_kernel_config: { 
            version: 'latest', 
            type: 'chrome' 
          }
        }
      };
      
      let res;
      try {
        res = await axios.post(`${this.apiUrl}/api/v2/browser-profile/update`, body, {
          timeout: 10000,
          headers,
          params: { api_key: this.apiKey }
        });
      } catch (postError) {
        // If POST fails, try with profile_id as array (some AdsPower versions require array)
        const bodyArray = {
          profile_id: [profileId],
          api_key: this.apiKey,
          fingerprint_config: {
            browser_kernel_config: { 
              version: 'latest', 
              type: 'chrome' 
            }
          }
        };
        res = await axios.post(`${this.apiUrl}/api/v2/browser-profile/update`, bodyArray, {
          timeout: 10000,
          headers,
          params: { api_key: this.apiKey }
        });
      }
      
      if (res.data?.code === 0) {
        console.log(`  ✓ Profile ${profileId} browser kernel set to latest Chrome (ua_auto)`);
        return true;
      } else {
        const errorMsg = res.data?.msg || 'Unknown error';
        console.warn(`  ⚠ Browser kernel update returned code ${res.data?.code}: ${errorMsg}`);
        // Log full response for debugging
        if (res.data) {
          console.log(`  Full response:`, JSON.stringify(res.data, null, 2));
        }
        
        // Try alternative: use profile_id as array (some AdsPower versions require array)
        try {
          console.log(`  → Trying browser kernel update with profile_id as array...`);
          const altBody = {
            profile_id: [profileId],
            api_key: this.apiKey,
            fingerprint_config: {
              browser_kernel_config: { 
                version: 'latest', 
                type: 'chrome' 
              }
            }
          };
          const altRes = await axios.post(`${this.apiUrl}/api/v2/browser-profile/update`, altBody, {
            timeout: 10000,
            headers
          });
          if (altRes.data?.code === 0) {
            console.log(`  ✓ Profile ${profileId} browser kernel updated with array format`);
            return true;
          } else {
            console.warn(`  ⚠ Array format returned code ${altRes.data?.code}: ${altRes.data?.msg || 'Unknown error'}`);
          }
        } catch (altErr) {
          console.warn(`  ⚠ Array format also failed:`, altErr.message);
          if (altErr.response?.data) {
            console.warn(`  Response:`, JSON.stringify(altErr.response.data, null, 2));
          }
        }
      }
    } catch (err) {
      console.warn(`  ⚠ Could not update browser kernel for ${profileId}:`, err.message);
      if (err.response?.data) {
        console.warn(`  Response:`, JSON.stringify(err.response.data, null, 2));
      }
    }
    return false;
  }

  async startProfile(profileId, options = {}) {
    if (!this.apiKey || this.apiKey.trim() === '') {
      throw new Error('ADSPOWER_API_KEY is required');
    }

    // Ensure profile uses latest browser kernel (e.g. Chrome 143) before starting
    await this.updateProfileBrowserKernel(profileId);

    // Add delay to prevent rate limiting when starting multiple profiles
    const timeSinceLastCall = Date.now() - this.lastStartProfileCall;
    if (timeSinceLastCall < this.startProfileMinInterval) {
      const delayNeeded = this.startProfileMinInterval - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, delayNeeded));
    }
    this.lastStartProfileCall = Date.now();

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'api-key': this.apiKey,
      'Api-Key': this.apiKey,
      'X-API-Key': this.apiKey
    };

    // Never use headless mode (Google detects it, terrible scores). Always run real browser.
    // When "run hidden" is on: put window off-screen with launch_args so it's invisible but not headless.
    // When "run hidden" is off: run normally (visible window, no launch_args).
    const headless = '0';
    // Determine if we want hidden based on openTabs: 0 = hidden (off-screen), 1 = visible (normal)
    const wantHidden = options.openTabs === 0;
    const launchArgs = wantHidden ? ['--window-position=-3000,-3000'] : undefined;

    // Prevent proxy detection page (start.adspower.net) from opening
    const proxyDetection = options.proxyDetection !== undefined ? options.proxyDetection : '0';
    const lastOpenedTabs = options.lastOpenedTabs !== undefined ? options.lastOpenedTabs : '0';

    const v2Data = {
      profile_id: profileId,
      api_key: this.apiKey,
      headless,
      proxy_detection: proxyDetection,
      last_opened_tabs: lastOpenedTabs
    };
    if (launchArgs && launchArgs.length) v2Data.launch_args = launchArgs;

    const v2Params = {
      profile_id: profileId,
      api_key: this.apiKey,
      headless,
      proxy_detection: proxyDetection,
      last_opened_tabs: lastOpenedTabs
    };

    const maxStartRetries = 3;
    const installWaitMs = 45000; // 45s when kernel is installing

    for (let attempt = 1; attempt <= maxStartRetries; attempt++) {
      try {
        let response;
        try {
          response = await axios.post(`${this.apiUrl}/api/v2/browser-profile/start`, v2Data, {
            timeout: 15000,
            headers: headers,
            params: v2Params
          });
        } catch (v2Error) {
          const v1Params = {
            user_id: profileId,
            api_key: this.apiKey,
            headless,
            proxy_detection: proxyDetection,
            last_opened_tabs: lastOpenedTabs
          };
          response = await axios.get(`${this.apiUrl}/api/v1/user/start`, {
            timeout: 15000,
            headers: headers,
            params: v1Params
          });
        }

        if (response.data?.code !== 0 && response.data?.code !== undefined) {
          const msg = (response.data?.msg || '').toLowerCase();
          if ((msg.includes('being installed') || msg.includes('is being installed')) && attempt < maxStartRetries) {
            console.warn(`SunBrowser/kernel is installing. Waiting ${installWaitMs / 1000}s before retry ${attempt}/${maxStartRetries}...`);
            await new Promise(r => setTimeout(r, installWaitMs));
            continue;
          }
          throw new Error(response.data?.msg || 'Failed to start profile');
        }

        return response.data;
      } catch (error) {
        const msg = (error.message || '').toLowerCase();
        if ((msg.includes('being installed') || msg.includes('is being installed')) && attempt < maxStartRetries) {
          console.warn(`SunBrowser/kernel is installing. Waiting ${installWaitMs / 1000}s before retry ${attempt}/${maxStartRetries}...`);
          await new Promise(r => setTimeout(r, installWaitMs));
          continue;
        }
        console.error('Error starting profile:', error.message);
        throw error;
      }
    }
    throw new Error('Failed to start profile after retries');
  }

  async stopProfile(profileId) {
    if (!this.apiKey || this.apiKey.trim() === '') {
      throw new Error('ADSPOWER_API_KEY is required');
    }

    // Add delay to prevent rate limiting when stopping multiple profiles
    const timeSinceLastCall = Date.now() - this.lastStartProfileCall;
    if (timeSinceLastCall < this.startProfileMinInterval) {
      const delayNeeded = this.startProfileMinInterval - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, delayNeeded));
    }
    this.lastStartProfileCall = Date.now();

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'api-key': this.apiKey,
      'Api-Key': this.apiKey,
      'X-API-Key': this.apiKey
    };

    // Try v2 endpoint first (POST with profile_id), then fallback to v1 (GET with user_id)
    try {
      let response;
      try {
        // Try v2 POST endpoint - uses profile_id
        const v2Data = {
          profile_id: profileId,
          api_key: this.apiKey
        };
        const v2Params = {
          profile_id: profileId,
          api_key: this.apiKey
        };
        response = await axios.post(`${this.apiUrl}/api/v2/browser-profile/stop`, v2Data, {
          timeout: 15000,
          headers: headers,
          params: v2Params
        });
      } catch (v2Error) {
        // Fallback to v1 GET endpoint - uses user_id
        const v1Params = {
          user_id: profileId,
          api_key: this.apiKey
        };
        response = await axios.get(`${this.apiUrl}/api/v1/user/stop`, {
          timeout: 15000,
          headers: headers,
          params: v1Params
        });
      }
      
      if (response.data?.code !== 0 && response.data?.code !== undefined) {
        const msg = (response.data?.msg || '').toLowerCase();
        if (msg.includes('not open') || msg.includes('is not open')) {
          return response.data;
        }
        throw new Error(response.data?.msg || 'Failed to stop profile');
      }

      return response.data;
    } catch (error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('not open') || msg.includes('is not open')) {
        return {};
      }
      console.error('Error stopping profile:', error.message);
      throw error;
    }
  }

  async getBrowserWSEndpoint(profileId) {
    if (!this.apiKey || this.apiKey.trim() === '') {
      throw new Error('ADSPOWER_API_KEY is required');
    }

    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'api-key': this.apiKey,
      'Api-Key': this.apiKey,
      'X-API-Key': this.apiKey
    };

    // Try v2 endpoint first (with profile_id), then fallback to v1 (with user_id)
    try {
      let response;
      try {
        // Try v2 endpoint - uses profile_id
        const v2Params = {
          profile_id: profileId,
          api_key: this.apiKey
        };
        response = await axios.get(`${this.apiUrl}/api/v2/browser-profile/active`, {
          timeout: 15000,
          headers: headers,
          params: v2Params
        });
      } catch (v2Error) {
        // Fallback to v1 endpoint - uses user_id
        const v1Params = {
          user_id: profileId,
          api_key: this.apiKey
        };
        response = await axios.get(`${this.apiUrl}/api/v1/user/active`, {
          timeout: 15000,
          headers: headers,
          params: v1Params
        });
      }
      
      if (response.data?.code !== 0 && response.data?.code !== undefined) {
        throw new Error(response.data?.msg || 'Failed to get browser endpoint');
      }
      
      // Check multiple possible locations for WebSocket endpoint
      const wsEndpoint = response.data?.data?.ws?.puppeteer || 
                        response.data?.data?.puppeteer || 
                        response.data?.ws?.puppeteer ||
                        response.data?.puppeteer;
      
      if (wsEndpoint) {
        return wsEndpoint;
      }
      
      throw new Error('WebSocket endpoint not found in response');
    } catch (error) {
      console.error('Error getting browser endpoint:', error.message);
      throw error;
    }
  }

  async connectBrowser(profileId, options = {}) {
    try {
      // Start profile with visibility control:
      // openTabs: 0 = hidden (off-screen window, not headless), 1 = visible (normal window)
      // Default to hidden (0) if not specified
      await this.startProfile(profileId, { openTabs: options.openTabs !== undefined ? options.openTabs : 0 });
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const wsEndpoint = await this.getBrowserWSEndpoint(profileId);
      
      const browser = await puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: null,
        protocolTimeout: 600000 // 10 minutes timeout for protocol operations (increased for slow connections)
      });

      // Immediately close start.adspower.net page and create new page with action URL
      // Default to google.com instead of start.adspower.net
      const initialUrl = options.initialUrl || 'https://www.google.com';
      try {
        const pages = await browser.pages();
        let startPageFound = false;
        
        // Close all start.adspower.net pages immediately
        for (const page of pages) {
          try {
            const url = page.url();
            if (url.includes('start.adspower.net')) {
              startPageFound = true;
              // Close the start page immediately without navigating
              await page.close().catch(() => {});
            }
          } catch (pageError) {
            // Ignore errors for individual pages
          }
        }
        
        // If we closed the start page, create a new page with the action URL (or google.com by default)
        if (startPageFound) {
          console.log(`Creating new page with default URL: ${initialUrl}`);
          const newPage = await browser.newPage().catch(() => null);
          if (newPage) {
            await newPage.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {
              // If navigation fails, navigate to about:blank as fallback
              newPage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
            });
            console.log(`✓ New page created and navigated to: ${initialUrl}`);
          }
        } else {
          // If no start page found, navigate existing page to default URL (google.com)
          const existingPage = pages[0];
          if (existingPage && !existingPage.isClosed()) {
            await existingPage.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
            console.log(`✓ Navigated existing page to: ${initialUrl}`);
          }
        }
      } catch (navError) {
        // Ignore errors when handling start page
        console.log('Note: Could not handle start page (may already be handled)');
      }

      return browser;
    } catch (error) {
      console.error('Error connecting browser:', error.message);
      throw error;
    }
  }

  async closeAllTabsAndStopProfile(profileId, browser) {
    try {
      // Close all tabs before stopping to prevent saving tabs for next launch
      if (browser) {
        try {
          const pages = await browser.pages();
          console.log(`Closing ${pages.length} tab(s) before stopping profile...`);
          
          for (const page of pages) {
            try {
              if (!page.isClosed()) {
                await page.close();
              }
            } catch (pageError) {
              // Ignore errors for individual pages
            }
          }
          
          // Disconnect browser
          await browser.disconnect();
          console.log('✓ All tabs closed and browser disconnected');
        } catch (closeError) {
          console.warn('Error closing tabs:', closeError.message);
          // Still try to disconnect
          try {
            await browser.disconnect();
          } catch (disconnectError) {
            // Ignore disconnect errors
          }
        }
      }
      
      // Stop the profile in AdsPower (no-op if profile was never opened)
      await this.stopProfile(profileId);
      console.log(`✓ Profile ${profileId} fully stopped (tabs cleared)`);
    } catch (error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('not open') || msg.includes('is not open')) {
        return;
      }
      console.error('Error closing tabs and stopping profile:', error.message);
      throw error;
    }
  }

  async updateProfileNotes(profileId, notes) {
    if (!this.apiKey || this.apiKey.trim() === '') {
      throw new Error('ADSPOWER_API_KEY is required');
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'api-key': this.apiKey,
      'Api-Key': this.apiKey,
      'X-API-Key': this.apiKey
    };

    // Try v2 endpoint first (with profile_id), then fallback to v1 (with user_id)
    try {
      let response;
      let lastError;
      
      try {
        // Try v2 endpoint - uses profile_id (may need to be array)
        const v2Data = {
          profile_id: Array.isArray(profileId) ? profileId : [profileId],
          notes: notes,
          api_key: this.apiKey
        };
        const v2Params = {
          profile_id: Array.isArray(profileId) ? profileId : [profileId],
          api_key: this.apiKey
        };
        console.log(`Attempting v2 notes update for profile ${profileId} with notes: "${notes}"`);
        response = await axios.post(`${this.apiUrl}/api/v2/browser-profile/update`, v2Data, {
          timeout: 15000,
          headers: headers,
          params: v2Params
        });
        console.log(`v2 response:`, JSON.stringify(response.data, null, 2));
        
        if (response.data?.code !== 0 && response.data?.code !== undefined) {
          throw new Error(response.data?.msg || 'v2 endpoint returned error');
        }
        
        return response.data;
      } catch (v2Error) {
        lastError = v2Error;
        console.log(`v2 endpoint failed: ${v2Error.message}, trying v1 endpoint...`);
        
        // Fallback to v1 endpoint - uses user_id
        const v1Data = {
          user_id: profileId,
          notes: notes,
          api_key: this.apiKey
        };
        const v1Params = {
          user_id: profileId,
          api_key: this.apiKey
        };
        console.log(`Attempting v1 notes update for profile ${profileId} with notes: "${notes}"`);
        response = await axios.post(`${this.apiUrl}/api/v1/user/update`, v1Data, {
          timeout: 15000,
          headers: headers,
          params: v1Params
        });
        console.log(`v1 response:`, JSON.stringify(response.data, null, 2));
        
        if (response.data?.code !== 0 && response.data?.code !== undefined) {
          throw new Error(response.data?.msg || 'v1 endpoint returned error');
        }
        
        return response.data;
      }
    } catch (error) {
      console.error(`✗ Error updating profile notes for ${profileId}:`, error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  async deleteProfile(profileId) {
    if (!this.apiKey || this.apiKey.trim() === '') {
      throw new Error('ADSPOWER_API_KEY is required');
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'api-key': this.apiKey,
      'Api-Key': this.apiKey,
      'X-API-Key': this.apiKey
    };

    const profileIds = Array.isArray(profileId) ? profileId : [profileId];

    try {
      let response;
      try {
        // V2: POST body only; profile_id must be array (batch up to 100)
        response = await axios.post(
          `${this.apiUrl}/api/v2/browser-profile/delete`,
          { profile_id: profileIds },
          {
            timeout: 15000,
            headers: headers,
            params: this.apiKey ? { api_key: this.apiKey } : {}
          }
        );
      } catch (v2Error) {
        // V1 fallback: single profile by user_id
        const singleId = profileIds[0];
        if (!singleId) throw new Error('No profile id to delete');
        response = await axios.get(`${this.apiUrl}/api/v1/user/delete`, {
          timeout: 15000,
          headers: headers,
          params: { user_id: singleId, api_key: this.apiKey }
        });
      }

      if (response.data?.code !== 0 && response.data?.code !== undefined) {
        throw new Error(response.data?.msg || 'Failed to delete profile');
      }

      return response.data;
    } catch (error) {
      console.error('Error deleting profile:', error.message);
      throw error;
    }
  }
}
