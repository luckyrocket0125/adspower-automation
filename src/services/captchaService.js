import { CapMonsterService } from './capmonster.js';
import dotenv from 'dotenv';

dotenv.config();

// Service priority order (first available will be used)
// Default: AntiCaptcha → 2Captcha → CapMonster
const SERVICE_PRIORITY = process.env.CAPTCHA_SERVICE_PRIORITY 
  ? process.env.CAPTCHA_SERVICE_PRIORITY.split(',').map(s => s.trim().toLowerCase())
  : ['anticaptcha', '2captcha', 'capmonster'];

export class CaptchaService {
  constructor() {
    this.services = [];
    this.currentService = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    console.log('[CaptchaService] Initializing services...');
    console.log(`[CaptchaService] Priority order: ${SERVICE_PRIORITY.join(' → ')}`);
    
    // Initialize available services (order doesn't matter, will be sorted by priority)
    // if (process.env.CAPMONSTER_API_KEY) {
    //   this.services.push({ name: 'capmonster', service: new CapMonsterService() });
    //   console.log('[CaptchaService] CapMonster service added');
    // }
    
    // Try to load AntiCaptcha service dynamically
    if (process.env.ANTICAPTCHA_API_KEY) {
      try {
        const { AntiCaptchaService } = await import('./anticaptcha.js');
        this.services.push({ name: 'anticaptcha', service: new AntiCaptchaService() });
        console.log('[CaptchaService] AntiCaptcha service added');
      } catch (e) {
        console.log('[CaptchaService] AntiCaptcha service not available:', e.message);
      }
    }
    
    // Try to load 2Captcha service dynamically
    if (process.env.TWOCAPTCHA_API_KEY) {
      try {
        const { TwoCaptchaService } = await import('./twocaptcha.js');
        this.services.push({ name: '2captcha', service: new TwoCaptchaService() });
        console.log('[CaptchaService] 2Captcha service added');
      } catch (e) {
        console.log('[CaptchaService] 2Captcha service not available:', e.message);
      }
    }
    
    console.log(`[CaptchaService] Found ${this.services.length} service(s): ${this.services.map(s => s.name).join(', ')}`);
    
    // Select service based on priority
    this.selectService();
    this.initialized = true;
  }

  selectService() {
    // Sort services by priority
    const sortedServices = [...this.services].sort((a, b) => {
      const aIndex = SERVICE_PRIORITY.indexOf(a.name);
      const bIndex = SERVICE_PRIORITY.indexOf(b.name);
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    });
    
    // Store sorted services for use in solving methods
    this.sortedServices = sortedServices;
    
    if (sortedServices.length > 0) {
      this.currentService = sortedServices[0];
      const priorityIndex = SERVICE_PRIORITY.indexOf(this.currentService.name);
      console.log(`[CaptchaService] Primary service: ${this.currentService.name} (priority ${priorityIndex + 1} of ${SERVICE_PRIORITY.length})`);
      console.log(`[CaptchaService] Services in priority order: ${sortedServices.map(s => s.name).join(' → ')}`);
      if (sortedServices.length > 1) {
        console.log(`[CaptchaService] Fallback services: ${sortedServices.slice(1).map(s => s.name).join(', ')}`);
      }
    } else {
      console.log('[CaptchaService] No CAPTCHA service configured');
    }
  }

  get apiKey() {
    // For synchronous access, check if any service is configured
    // The actual service selection will happen in initialize() which respects priority
    if (process.env.CAPMONSTER_API_KEY || process.env.ANTICAPTCHA_API_KEY || process.env.TWOCAPTCHA_API_KEY) {
      // Return a truthy value to indicate a service is configured
      // The actual service will be selected in initialize() with proper priority
      return 'configured';
    }
    return null;
  }

  async solveReCaptchaV2(websiteUrl, websiteKey) {
    await this.initialize();
    
    if (this.services.length === 0) {
      throw new Error('No CAPTCHA service configured. Please set at least one: CAPMONSTER_API_KEY, ANTICAPTCHA_API_KEY, or TWOCAPTCHA_API_KEY');
    }

    // Try all available services in priority order
    const errors = [];
    const servicesToTry = this.sortedServices || this.services;
    
    for (const service of servicesToTry) {
      try {
        console.log(`[CaptchaService] Attempting to solve reCAPTCHA v2 with ${service.name}...`);
        const result = await service.service.solveReCaptchaV2(websiteUrl, websiteKey);
        console.log(`✓ [CaptchaService] Successfully solved with ${service.name}`);
        return result;
      } catch (error) {
        console.error(`✗ [CaptchaService] ${service.name} failed:`, error.message);
        errors.push({ service: service.name, error: error.message });
        
        // If there are more services to try, continue
        if (servicesToTry.indexOf(service) < servicesToTry.length - 1) {
          console.log(`[CaptchaService] Trying next service in priority order...`);
        }
        continue;
      }
    }
    
    // All services failed
    console.error('');
    console.error('✗✗✗ ALL CAPTCHA SERVICES FAILED ✗✗✗');
    console.error(`Tried ${servicesToTry.length} service(s): ${servicesToTry.map(s => s.name).join(', ')}`);
    errors.forEach(({ service, error }) => {
      console.error(`  - ${service}: ${error}`);
    });
    console.error('');
    
    throw new Error(`All CAPTCHA services failed. Tried: ${servicesToTry.map(s => s.name).join(', ')}. Last error: ${errors[errors.length - 1]?.error || 'Unknown'}`);
  }

  async solveReCaptchaV3(websiteUrl, websiteKey, pageAction = 'verify', minScore = 0.3) {
    await this.initialize();
    
    if (this.services.length === 0) {
      throw new Error('No CAPTCHA service configured. Please set at least one: CAPMONSTER_API_KEY, ANTICAPTCHA_API_KEY, or TWOCAPTCHA_API_KEY');
    }

    // Try all available services in priority order
    const errors = [];
    const servicesToTry = this.sortedServices || this.services;
    
    for (const service of servicesToTry) {
      try {
        console.log(`[CaptchaService] Attempting to solve reCAPTCHA v3 with ${service.name}...`);
        const result = await service.service.solveReCaptchaV3(websiteUrl, websiteKey, pageAction, minScore);
        console.log(`✓ [CaptchaService] Successfully solved with ${service.name}`);
        return result;
      } catch (error) {
        console.error(`✗ [CaptchaService] ${service.name} failed:`, error.message);
        errors.push({ service: service.name, error: error.message });
        
        // If there are more services to try, continue
        if (servicesToTry.indexOf(service) < servicesToTry.length - 1) {
          console.log(`[CaptchaService] Trying next service in priority order...`);
        }
        continue;
      }
    }
    
    // All services failed
    throw new Error(`All CAPTCHA services failed. Tried: ${servicesToTry.map(s => s.name).join(', ')}. Last error: ${errors[errors.length - 1]?.error || 'Unknown'}`);
  }

  async solveHCaptcha(websiteUrl, websiteKey) {
    await this.initialize();
    
    if (this.services.length === 0) {
      throw new Error('No CAPTCHA service configured. Please set at least one: CAPMONSTER_API_KEY, ANTICAPTCHA_API_KEY, or TWOCAPTCHA_API_KEY');
    }

    // Try all available services in priority order
    const errors = [];
    const servicesToTry = this.sortedServices || this.services;
    
    for (const service of servicesToTry) {
      try {
        console.log(`[CaptchaService] Attempting to solve hCaptcha with ${service.name}...`);
        const result = await service.service.solveHCaptcha(websiteUrl, websiteKey);
        console.log(`✓ [CaptchaService] Successfully solved with ${service.name}`);
        return result;
      } catch (error) {
        console.error(`✗ [CaptchaService] ${service.name} failed:`, error.message);
        errors.push({ service: service.name, error: error.message });
        
        // If there are more services to try, continue
        if (servicesToTry.indexOf(service) < servicesToTry.length - 1) {
          console.log(`[CaptchaService] Trying next service in priority order...`);
        }
        continue;
      }
    }
    
    // All services failed
    throw new Error(`All CAPTCHA services failed. Tried: ${servicesToTry.map(s => s.name).join(', ')}. Last error: ${errors[errors.length - 1]?.error || 'Unknown'}`);
  }
}
