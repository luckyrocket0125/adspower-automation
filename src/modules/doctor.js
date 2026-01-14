import { AdsPowerService } from '../services/adspower.js';
import { Profile } from '../models/Profile.js';
import { TrustScore } from '../models/TrustScore.js';
import { InteractionLog } from '../models/InteractionLog.js';
import { HumanEmulation } from '../utils/humanEmulation.js';
import axios from 'axios';

export class Doctor {
  constructor() {
    this.adspower = new AdsPowerService();
  }

  async runDiagnostics(profileId) {
    const profile = await Profile.findById(profileId);
    if (!profile) {
      throw new Error(`Profile ${profileId} not found`);
    }

    const results = {
      trustScore: null,
      personaIntegrity: null,
      shadowbanStatus: null,
      overall: 'healthy'
    };

    let browser;
    let page;

    try {
      browser = await this.adspower.connectBrowser(profileId);
      page = (await browser.pages())[0] || await browser.newPage();

      results.trustScore = await this.checkTrustScore(page, profileId);
      results.personaIntegrity = await this.checkPersonaIntegrity(page, profileId);
      results.shadowbanStatus = await this.checkShadowban(page, profileId);

      if (results.trustScore < 0.7 && profile.createdAt < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) {
        await Profile.updateStatus(profileId, 'rehab');
        results.overall = 'rehab_needed';
      } else if (results.trustScore < 0.9 || !results.personaIntegrity) {
        results.overall = 'needs_farming';
      }

      return results;
    } catch (error) {
      console.error(`Doctor diagnostics error for profile ${profileId}:`, error);
      throw error;
    } finally {
      if (browser) {
        await browser.disconnect();
      }
    }
  }

  async checkTrustScore(page, profileId) {
    try {
      await page.goto('https://antcpt.com/score_detector/', { waitUntil: 'networkidle2' });
      await HumanEmulation.randomDelay(3000, 5000);

      await HumanEmulation.simulateReading(page, 2000);

      const score = await page.evaluate(() => {
        const scoreElement = document.querySelector('.score, [class*="score"], [id*="score"]');
        if (scoreElement) {
          const text = scoreElement.textContent;
          const match = text.match(/(\d+\.?\d*)/);
          return match ? parseFloat(match[1]) / 100 : null;
        }
        return null;
      });

      if (score !== null) {
        const trustScore = new TrustScore({
          profileId,
          score,
          source: 'antcpt',
          metadata: { timestamp: new Date() }
        });
        await trustScore.save();

        await Profile.updateTrustScore(profileId, score);
        try {
          const log = new InteractionLog({
            profileId,
            action: 'trust_score_check',
            url: 'https://antcpt.com/score_detector/',
            success: true,
            metadata: { score }
          });
          await log.save();
        } catch (logError) {
          console.error('Failed to save trust score log:', logError);
        }
      }

      return score || 0;
    } catch (error) {
      console.error('Trust score check error:', error);
      try {
        const log = new InteractionLog({
          profileId,
          action: 'trust_score_check',
          url: 'https://antcpt.com/score_detector/',
          success: false,
          error: error.message
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save error log:', logError);
      }
      return 0;
    }
  }

  async checkPersonaIntegrity(page, profileId) {
    try {
      await page.goto('https://myadcenter.google.com/', { waitUntil: 'networkidle2' });
      await HumanEmulation.randomDelay(3000, 5000);

      await HumanEmulation.simulateReading(page, 2000);

      const personalizedAdsOn = await page.evaluate(() => {
        const toggle = document.querySelector('input[type="checkbox"][checked], [aria-checked="true"]');
        const text = document.body.textContent.toLowerCase();
        return toggle !== null || text.includes('personalized ads') && text.includes('on');
      });

      try {
        const log = new InteractionLog({
          profileId,
          action: 'persona_integrity_check',
          url: 'https://myadcenter.google.com/',
          success: true,
          metadata: { personalizedAdsOn }
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save persona integrity log:', logError);
      }

      if (!personalizedAdsOn) {
        await Profile.updateStatus(profileId, 'needs_farming');
      }

      return personalizedAdsOn;
    } catch (error) {
      console.error('Persona integrity check error:', error);
      try {
        const log = new InteractionLog({
          profileId,
          action: 'persona_integrity_check',
          url: 'https://myadcenter.google.com/',
          success: false,
          error: error.message
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save error log:', logError);
      }
      return false;
    }
  }

  async checkShadowban(page, profileId) {
    try {
      const testVideoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      await page.goto(testVideoUrl, { waitUntil: 'networkidle2' });
      await HumanEmulation.randomDelay(3000, 5000);

      const commentText = `Test comment ${Date.now()}`;
      
      const commentBox = await page.$('#placeholder-area, #contenteditable-root');
      if (commentBox) {
        await HumanEmulation.humanType(page, '#placeholder-area, #contenteditable-root', commentText);
        await HumanEmulation.randomDelay(1000, 2000);
        
        const submitButton = await page.$('button[aria-label*="Comment"], button[id*="submit"]');
        if (submitButton) {
          await page.click('button[aria-label*="Comment"], button[id*="submit"]');
          await HumanEmulation.randomDelay(5000, 7000);
        }
      }

      await HumanEmulation.randomDelay(10000, 15000);

      const response = await axios.get(testVideoUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const commentVisible = response.data.includes(commentText);

      try {
        const log = new InteractionLog({
          profileId,
          action: 'shadowban_check',
          url: testVideoUrl,
          success: true,
          metadata: { shadowbanned: !commentVisible }
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save shadowban check log:', logError);
      }

      if (!commentVisible) {
        await Profile.updateStatus(profileId, 'ghosted');
      }

      return !commentVisible;
    } catch (error) {
      console.error('Shadowban check error:', error);
      try {
        const log = new InteractionLog({
          profileId,
          action: 'shadowban_check',
          url: 'youtube.com',
          success: false,
          error: error.message
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save error log:', logError);
      }
      return false;
    }
  }
}
