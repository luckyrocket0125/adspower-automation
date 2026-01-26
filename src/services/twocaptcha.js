import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY;
const TWOCAPTCHA_API_URL = 'https://2captcha.com';

export class TwoCaptchaService {
  constructor() {
    this.apiKey = TWOCAPTCHA_API_KEY;
    this.apiUrl = TWOCAPTCHA_API_URL;
  }

  async createTask(websiteUrl, websiteKey, captchaType = 'recaptcha2') {
    if (!this.apiKey) {
      throw new Error('TWOCAPTCHA_API_KEY is not configured');
    }

    try {
      // 2captcha uses different API format - in.php endpoint
      const params = new URLSearchParams();
      params.append('key', this.apiKey);
      params.append('method', captchaType === 'recaptcha2' ? 'userrecaptcha' : 
                                  captchaType === 'recaptcha3' ? 'userrecaptcha' : 
                                  'hcaptcha');
      params.append('googlekey', websiteKey);
      params.append('pageurl', websiteUrl);
      params.append('json', '1');

      const response = await axios.post(`${this.apiUrl}/in.php`, params.toString(), {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      if (response.data.status === 1 && response.data.request) {
        return response.data.request; // This is the task ID
      } else {
        throw new Error(response.data.request || 'Failed to create 2captcha task');
      }
    } catch (error) {
      console.error('2captcha create task error:', error.message);
      if (error.response) {
        console.error('Response:', error.response.data);
      }
      throw error;
    }
  }

  async getTaskResult(taskId, maxWaitTime = 300000, checkInterval = 5000) {
    const startTime = Date.now();
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 5;

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // 2captcha uses res.php endpoint
        const response = await axios.get(`${this.apiUrl}/res.php`, {
          params: {
            key: this.apiKey,
            action: 'get',
            id: taskId,
            json: 1
          },
          timeout: 15000
        });

        if (response.data.status === 1 && response.data.request) {
          // Success - return the token
          return { gRecaptchaResponse: response.data.request };
        } else if (response.data.request === 'CAPCHA_NOT_READY') {
          // Still processing
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          if (elapsed % 10 === 0) {
            console.log(`[2captcha] Task ${taskId} is processing... (${elapsed}s elapsed)`);
          }
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          continue;
        } else {
          // Error
          throw new Error(response.data.request || '2captcha task error');
        }
      } catch (error) {
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          console.log(`[2captcha] Request timeout, retrying...`);
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          continue;
        }
        
        if (error.response && error.response.data) {
          console.error('[2captcha] get result error:', error.response.data);
        }
        
        consecutiveErrors++;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw error;
        }
        
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
    }

    throw new Error(`2captcha timeout: Task not completed within ${maxWaitTime / 1000} seconds`);
  }

  async solveReCaptchaV2(websiteUrl, websiteKey) {
    try {
      console.log('[2captcha] Creating reCAPTCHA v2 task...');
      console.log(`Website URL: ${websiteUrl}`);
      console.log(`Site Key: ${websiteKey ? websiteKey.substring(0, 20) + '...' : 'MISSING'}`);
      
      if (!websiteKey || websiteKey.length < 20) {
        throw new Error('Invalid site key provided for reCAPTCHA v2');
      }
      
      const taskId = await this.createTask(websiteUrl, websiteKey, 'recaptcha2');
      console.log(`✓ [2captcha] Task created successfully: ${taskId}`);
      
      console.log('[2captcha] Waiting to solve the challenge (this may take 1-3 minutes)...');
      
      const solution = await this.getTaskResult(taskId, 300000, 5000);
      
      if (!solution || !solution.gRecaptchaResponse) {
        throw new Error('2captcha returned invalid solution for reCAPTCHA v2');
      }
      
      console.log('✓ [2captcha] reCAPTCHA v2 solved successfully!');
      console.log(`Token length: ${solution.gRecaptchaResponse.length} characters`);
      
      return solution.gRecaptchaResponse;
    } catch (error) {
      console.error('✗ [2captcha] solve reCAPTCHA v2 error:', error.message);
      throw error;
    }
  }

  async solveReCaptchaV3(websiteUrl, websiteKey, pageAction = 'verify', minScore = 0.3) {
    try {
      console.log('[2captcha] Creating reCAPTCHA v3 task...');
      const taskId = await this.createTask(websiteUrl, websiteKey, 'recaptcha3');
      console.log(`[2captcha] Task created: ${taskId}`);
      
      console.log('[2captcha] Waiting for solution (this may take up to 5 minutes)...');
      const solution = await this.getTaskResult(taskId, 300000, 5000);
      
      if (!solution || !solution.gRecaptchaResponse) {
        throw new Error('2captcha returned invalid solution for reCAPTCHA v3');
      }
      
      console.log('[2captcha] reCAPTCHA v3 solved!');
      return solution.gRecaptchaResponse;
    } catch (error) {
      console.error('[2captcha] solve reCAPTCHA v3 error:', error.message);
      throw error;
    }
  }

  async solveHCaptcha(websiteUrl, websiteKey) {
    try {
      console.log('[2captcha] Creating hCaptcha task...');
      const taskId = await this.createTask(websiteUrl, websiteKey, 'hcaptcha');
      console.log(`[2captcha] Task created: ${taskId}`);
      
      console.log('[2captcha] Waiting for solution...');
      const solution = await this.getTaskResult(taskId);
      console.log('[2captcha] hCaptcha solved!');
      
      return solution.gRecaptchaResponse;
    } catch (error) {
      console.error('[2captcha] solve hCaptcha error:', error.message);
      throw error;
    }
  }
}
