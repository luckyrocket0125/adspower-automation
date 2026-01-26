import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const ANTICAPTCHA_API_KEY = process.env.ANTICAPTCHA_API_KEY;
const ANTICAPTCHA_API_URL = 'https://api.anti-captcha.com';

export class AntiCaptchaService {
  constructor() {
    this.apiKey = ANTICAPTCHA_API_KEY;
    this.apiUrl = ANTICAPTCHA_API_URL;
  }

  async createTask(taskType, websiteUrl, websiteKey, pageAction = null) {
    if (!this.apiKey) {
      throw new Error('ANTICAPTCHA_API_KEY is not configured');
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
        throw new Error(response.data.errorDescription || 'Failed to create AntiCaptcha task');
      }
    } catch (error) {
      console.error('AntiCaptcha create task error:', error.message);
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
          const errorMsg = response.data.errorDescription || 'AntiCaptcha task error';
          console.error(`AntiCaptcha task error (errorId: ${response.data.errorId}):`, errorMsg);
          
          if (response.data.errorId === 16) {
            throw new Error('Task not found or expired');
          }
          
          consecutiveErrors++;
          if (consecutiveErrors >= maxConsecutiveErrors) {
            throw new Error(`AntiCaptcha task failed: ${errorMsg}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, checkInterval * 2));
          continue;
        }

        consecutiveErrors = 0;

        if (response.data.status === 'ready') {
          if (!response.data.solution) {
            throw new Error('AntiCaptcha returned ready status but no solution');
          }
          return response.data.solution;
        }

        if (response.data.status === 'processing') {
          if (response.data.status !== lastStatus) {
            console.log(`AntiCaptcha task ${taskId} is processing... (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)`);
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
          console.error('AntiCaptcha get result error:', error.response.data);
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

    throw new Error(`AntiCaptcha timeout: Task not completed within ${maxWaitTime / 1000} seconds`);
  }

  async solveReCaptchaV2(websiteUrl, websiteKey) {
    try {
      console.log('[AntiCaptcha] Creating reCAPTCHA v2 task...');
      console.log(`Website URL: ${websiteUrl}`);
      console.log(`Site Key: ${websiteKey ? websiteKey.substring(0, 20) + '...' : 'MISSING'}`);
      
      if (!websiteKey || websiteKey.length < 20) {
        throw new Error('Invalid site key provided for reCAPTCHA v2');
      }
      
      const taskId = await this.createTask('RecaptchaV2TaskProxyless', websiteUrl, websiteKey);
      console.log(`✓ [AntiCaptcha] Task created successfully: ${taskId}`);
      
      console.log('[AntiCaptcha] Waiting to solve the challenge (this may take 1-3 minutes)...');
      
      const solution = await this.getTaskResult(taskId, 300000, 3000);
      
      if (!solution || !solution.gRecaptchaResponse) {
        throw new Error('AntiCaptcha returned invalid solution for reCAPTCHA v2');
      }
      
      console.log('✓ [AntiCaptcha] reCAPTCHA v2 solved successfully!');
      console.log(`Token length: ${solution.gRecaptchaResponse.length} characters`);
      
      return solution.gRecaptchaResponse;
    } catch (error) {
      console.error('✗ [AntiCaptcha] solve reCAPTCHA v2 error:', error.message);
      throw error;
    }
  }

  async solveReCaptchaV3(websiteUrl, websiteKey, pageAction = 'verify', minScore = 0.3) {
    try {
      console.log('[AntiCaptcha] Creating reCAPTCHA v3 task...');
      const taskId = await this.createTask('RecaptchaV3TaskProxyless', websiteUrl, websiteKey, pageAction);
      console.log(`[AntiCaptcha] Task created: ${taskId}`);
      
      console.log('[AntiCaptcha] Waiting for solution (this may take up to 5 minutes)...');
      const solution = await this.getTaskResult(taskId, 300000, 3000);
      
      if (!solution || !solution.gRecaptchaResponse) {
        throw new Error('AntiCaptcha returned invalid solution for reCAPTCHA v3');
      }
      
      console.log('[AntiCaptcha] reCAPTCHA v3 solved!');
      return solution.gRecaptchaResponse || solution.token;
    } catch (error) {
      console.error('[AntiCaptcha] solve reCAPTCHA v3 error:', error.message);
      throw error;
    }
  }

  async solveHCaptcha(websiteUrl, websiteKey) {
    try {
      console.log('[AntiCaptcha] Creating hCaptcha task...');
      const taskId = await this.createTask('HcaptchaTaskProxyless', websiteUrl, websiteKey);
      console.log(`[AntiCaptcha] Task created: ${taskId}`);
      
      console.log('[AntiCaptcha] Waiting for solution...');
      const solution = await this.getTaskResult(taskId);
      console.log('[AntiCaptcha] hCaptcha solved!');
      
      return solution.gRecaptchaResponse;
    } catch (error) {
      console.error('[AntiCaptcha] solve hCaptcha error:', error.message);
      throw error;
    }
  }
}
