import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const CAPMONSTER_API_KEY = process.env.CAPMONSTER_API_KEY;
const CAPMONSTER_API_URL = 'https://api.capmonster.cloud';

export class CapMonsterService {
  constructor() {
    this.apiKey = CAPMONSTER_API_KEY;
    this.apiUrl = CAPMONSTER_API_URL;
  }

  async createTask(taskType, websiteUrl, websiteKey, pageAction = null) {
    if (!this.apiKey) {
      throw new Error('CAPMONSTER_API_KEY is not configured');
    }

    try {
      const taskData = {
        type: taskType,
        websiteURL: websiteUrl,
        websiteKey: websiteKey
      };

      if (pageAction) {
        taskData.pageAction = pageAction;
      }

      const response = await axios.post(`${this.apiUrl}/createTask`, {
        clientKey: this.apiKey,
        task: taskData
      }, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.data.errorId === 0 && response.data.taskId) {
        return response.data.taskId;
      } else {
        throw new Error(response.data.errorDescription || 'Failed to create CapMonster task');
      }
    } catch (error) {
      console.error('CapMonster create task error:', error.message);
      if (error.response) {
        console.error('Response:', error.response.data);
      }
      throw error;
    }
  }

  async getTaskResult(taskId, maxWaitTime = 300000, checkInterval = 3000) {
    const startTime = Date.now();
    let lastStatus = null;
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const response = await axios.post(`${this.apiUrl}/getTaskResult`, {
          clientKey: this.apiKey,
          taskId: taskId
        }, {
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if (response.data.errorId !== 0) {
          const errorMsg = response.data.errorDescription || 'CapMonster task error';
          console.error(`CapMonster task error (errorId: ${response.data.errorId}):`, errorMsg);
          
          if (response.data.errorId === 16) {
            throw new Error('Task not found or expired');
          }
          
          consecutiveErrors++;
          if (consecutiveErrors >= maxConsecutiveErrors) {
            throw new Error(`CapMonster task failed: ${errorMsg}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, checkInterval * 2));
          continue;
        }

        consecutiveErrors = 0;

        if (response.data.status === 'ready') {
          if (!response.data.solution) {
            throw new Error('CapMonster returned ready status but no solution');
          }
          return response.data.solution;
        }

        if (response.data.status === 'processing') {
          if (response.data.status !== lastStatus) {
            console.log(`CapMonster task ${taskId} is processing... (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)`);
            lastStatus = response.data.status;
          }
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          continue;
        }

        throw new Error(`Unknown task status: ${response.data.status}`);
      } catch (error) {
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          console.log(`Request timeout, retrying... (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)`);
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          continue;
        }
        
        if (error.response && error.response.data) {
          console.error('CapMonster get result error:', error.response.data);
        }
        
        if (error.message.includes('not found') || error.message.includes('expired')) {
          throw error;
        }
        
        consecutiveErrors++;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw error;
        }
        
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
    }

    throw new Error(`CapMonster timeout: Task not completed within ${maxWaitTime / 1000} seconds`);
  }

  async solveReCaptchaV2(websiteUrl, websiteKey) {
    try {
      console.log('Creating reCAPTCHA v2 task...');
      console.log(`Website URL: ${websiteUrl}`);
      console.log(`Site Key: ${websiteKey ? websiteKey.substring(0, 20) + '...' : 'MISSING'}`);
      
      if (!websiteKey || websiteKey.length < 20) {
        throw new Error('Invalid site key provided for reCAPTCHA v2');
      }
      
      const taskId = await this.createTask('RecaptchaV2TaskProxyless', websiteUrl, websiteKey);
      console.log(`✓ Task created successfully: ${taskId}`);
      
      console.log('Waiting for CapMonster to solve the challenge (this may take 1-3 minutes)...');
      console.log('Note: If image selection challenge appears, CapMonster will solve it automatically');
      
      const solution = await this.getTaskResult(taskId, 300000, 3000);
      
      if (!solution || !solution.gRecaptchaResponse) {
        throw new Error('CapMonster returned invalid solution for reCAPTCHA v2');
      }
      
      console.log('✓ reCAPTCHA v2 solved successfully!');
      console.log(`Token length: ${solution.gRecaptchaResponse.length} characters`);
      
      return solution.gRecaptchaResponse;
    } catch (error) {
      console.error('✗ CapMonster solve reCAPTCHA v2 error:', error.message);
      if (error.message.includes('timeout')) {
        console.error('The CAPTCHA solving timed out. This could be due to:');
        console.error('1. Complex image challenge that took too long');
        console.error('2. CapMonster server load');
        console.error('3. Network issues');
        console.error('Consider checking your CapMonster account balance and try again');
      }
      throw error;
    }
  }

  async solveReCaptchaV3(websiteUrl, websiteKey, pageAction = 'verify', minScore = 0.3) {
    try {
      console.log('Creating reCAPTCHA v3 task...');
      console.log(`Website URL: ${websiteUrl}`);
      console.log(`Site Key: ${websiteKey.substring(0, 20)}...`);
      console.log(`Page Action: ${pageAction}, Min Score: ${minScore}`);
      
      const taskId = await this.createTask('RecaptchaV3TaskProxyless', websiteUrl, websiteKey, pageAction);
      console.log(`Task created: ${taskId}`);
      
      console.log('Waiting for solution (this may take up to 5 minutes)...');
      const solution = await this.getTaskResult(taskId, 300000, 3000);
      
      if (!solution || !solution.gRecaptchaResponse) {
        throw new Error('CapMonster returned invalid solution for reCAPTCHA v3');
      }
      
      console.log('reCAPTCHA v3 solved!');
      if (solution.token) {
        console.log(`Token received (length: ${solution.token.length})`);
        return solution.token;
      }
      
      return solution.gRecaptchaResponse;
    } catch (error) {
      console.error('CapMonster solve reCAPTCHA v3 error:', error.message);
      if (error.message.includes('timeout')) {
        console.error('The task is taking longer than expected. This might be due to:');
        console.error('1. High server load on CapMonster');
        console.error('2. Complex reCAPTCHA v3 challenge');
        console.error('3. Network issues');
        console.error('Consider trying again or using reCAPTCHA v2 if available');
      }
      throw error;
    }
  }

  async solveHCaptcha(websiteUrl, websiteKey) {
    try {
      console.log('Creating hCaptcha task...');
      const taskId = await this.createTask('HcaptchaTaskProxyless', websiteUrl, websiteKey);
      console.log(`Task created: ${taskId}`);
      
      console.log('Waiting for solution...');
      const solution = await this.getTaskResult(taskId);
      console.log('hCaptcha solved!');
      
      return solution.gRecaptchaResponse;
    } catch (error) {
      console.error('CapMonster solve hCaptcha error:', error.message);
      throw error;
    }
  }
}
