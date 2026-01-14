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
  }

  async createProfile(profileData) {
    const url = `${this.apiUrl}/api/v2/browser-profile/create`;

    if (!this.apiKey || this.apiKey.trim() === '') {
      console.error('ERROR: ADSPOWER_API_KEY is missing or empty!');
      console.error('Please add ADSPOWER_API_KEY=your_key_here to your .env file');
      throw new Error('ADSPOWER_API_KEY is required. Please set it in your .env file. Get it from AdsPower: Automation → API');
    }

    // HARD throttle: guarantee spacing at caller level
    console.log('Waiting 120s before profile creation...');
    await new Promise(r => setTimeout(r, 120_000));

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

  async getGroups() {
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
          params: params,
          headers: headers,
          timeout: 10000
        });
      } catch (v1Error) {
        // If v1 fails, try v2
        console.log('v1 group/list failed, trying v2...');
        response = await axios.get(`${this.apiUrl}/api/v2/group/list`, {
          params: params,
          headers: headers,
          timeout: 10000
        });
      }
      
      console.log('Groups API response:', JSON.stringify(response.data, null, 2));
      
      // Check response structure
      if (response.data?.code === 0) {
        // v1 format: response.data.data.list
        if (response.data?.data?.list) {
          const groups = response.data.data.list;
          console.log(`Found ${groups.length} groups:`, groups.map(g => `${g.group_name || g.name} (ID: ${g.group_id || g.id})`).join(', '));
          return groups;
        }
        // v2 format might be different
        if (response.data?.data) {
          const groups = Array.isArray(response.data.data) ? response.data.data : (response.data.data.list || []);
          console.log(`Found ${groups.length} groups:`, groups.map(g => `${g.group_name || g.name} (ID: ${g.group_id || g.id})`).join(', '));
          return groups;
        }
      }
      
      // If code is not 0, log the error message
      if (response.data?.code !== undefined && response.data?.code !== 0) {
        console.error('Groups API returned error:', response.data?.msg || response.data?.message || 'Unknown error');
        console.error('Full response:', JSON.stringify(response.data, null, 2));
      }
      
      console.log('No groups found in response, returning empty array');
      return [];
    } catch (error) {
      console.error('Error fetching groups:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', JSON.stringify(error.response.data, null, 2));
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
      return { group_id: groupId, group_name: groupName };
    } catch (error) {
      console.error('Error creating group:', error.message);
      throw error;
    }
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

  async startProfile(profileId) {
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
        response = await axios.post(`${this.apiUrl}/api/v2/browser-profile/start`, v2Data, {
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
        response = await axios.get(`${this.apiUrl}/api/v1/user/start`, {
          timeout: 15000,
          headers: headers,
          params: v1Params
        });
      }
      
      if (response.data?.code !== 0 && response.data?.code !== undefined) {
        throw new Error(response.data?.msg || 'Failed to start profile');
      }
      
      return response.data;
    } catch (error) {
      console.error('Error starting profile:', error.message);
      throw error;
    }
  }

  async stopProfile(profileId) {
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
        throw new Error(response.data?.msg || 'Failed to stop profile');
      }
      
      return response.data;
    } catch (error) {
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

  async connectBrowser(profileId) {
    try {
      await this.startProfile(profileId);
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const wsEndpoint = await this.getBrowserWSEndpoint(profileId);
      
      const browser = await puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: null
      });

      return browser;
    } catch (error) {
      console.error('Error connecting browser:', error.message);
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
      try {
        // Try v2 endpoint - uses profile_id
        const v2Data = {
          profile_id: profileId,
          notes: notes,
          api_key: this.apiKey
        };
        const v2Params = {
          profile_id: profileId,
          api_key: this.apiKey
        };
        response = await axios.post(`${this.apiUrl}/api/v2/browser-profile/update`, v2Data, {
          timeout: 15000,
          headers: headers,
          params: v2Params
        });
      } catch (v2Error) {
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
        response = await axios.post(`${this.apiUrl}/api/v1/user/update`, v1Data, {
          timeout: 15000,
          headers: headers,
          params: v1Params
        });
      }
      
      if (response.data?.code !== 0 && response.data?.code !== undefined) {
        throw new Error(response.data?.msg || 'Failed to update profile notes');
      }
      
      return response.data;
    } catch (error) {
      console.error('Error updating profile notes:', error.message);
      throw error;
    }
  }
}
