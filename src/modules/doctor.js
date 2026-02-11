import { AdsPowerService } from '../services/adspower.js';
import { Profile } from '../models/Profile.js';
import { TrustScore } from '../models/TrustScore.js';
import { InteractionLog } from '../models/InteractionLog.js';
import { HumanEmulation } from '../utils/humanEmulation.js';
import { generateYouTubeComment } from '../services/openai.js';
import axios from 'axios';

export class Doctor {
  constructor() {
    this.adspower = new AdsPowerService();
  }

  async runDiagnostics(profileId, options = {}) {
    const profile = await Profile.findById(profileId);
    if (!profile) {
      throw new Error(`Profile ${profileId} not found`);
    }

    const results = {
      passed: false,
      antcptScore: null,
      myadscenterPassed: false,
      youtubePassed: false,
      youtubeBanned: false,
      logs: []
    };

    let browser;
    let page;

    try {
      // Navigate directly to antcpt instead of showing start.adspower.net
      const openTabs = options.runHidden === false ? 1 : 0;
      browser = await this.adspower.connectBrowser(profileId, { initialUrl: 'https://antcpt.com/score_detector/', openTabs });
      
      // Ensure start.adspower.net page is closed (extra safety check)
      try {
        const pages = await browser.pages();
        for (const p of pages) {
          try {
            const url = p.url();
            if (url.includes('start.adspower.net')) {
              console.log('Closing start.adspower.net page (diagnostics safety check)...');
              await p.close();
              console.log('✓ start.adspower.net page closed');
            }
          } catch (pageError) {
            // Ignore errors for individual pages
          }
        }
      } catch (closeError) {
        // Ignore errors when closing start page
      }
      
      page = (await browser.pages())[0] || await browser.newPage();

      // Step 1: antcpt check
      console.log(`=== Step 1: Checking antcpt score for profile ${profileId} ===`);
      const antcptScore = await this.checkTrustScore(page, profileId);
      results.antcptScore = antcptScore;
      results.logs.push({ step: 'antcpt', score: antcptScore, passed: antcptScore !== null && antcptScore >= 0.9 });

      // Stop if antcpt score < 0.9 (0.9 is required to pass)
      if (!antcptScore || antcptScore < 0.9) {
        console.log(`✗ Check FAILED: antcpt check failed (score: ${antcptScore}, required: ≥0.9)`);
        results.passed = false;
        results.myadscenterPassed = null; // null means "not tested"
        results.youtubePassed = null; // null means "not tested"
        
        // Save diagnostics result to InteractionLog for client viewing
        try {
          const log = new InteractionLog({
            profileId,
            action: 'diagnostics_check',
            url: 'https://antcpt.com/score_detector/',
            success: false,
            error: `antcpt check failed (score: ${antcptScore}, required: ≥0.9)`,
            metadata: { 
              step: 'antcpt',
              antcptScore,
              myadscenterPassed: null, // null = not tested
              youtubePassed: null, // null = not tested
              myadscenterNotTested: true,
              youtubeNotTested: true,
              logs: results.logs
            }
          });
          await log.save();
          console.log('✓ Diagnostics log saved (antcpt failed, rest not tested)');
        } catch (logError) {
          console.error('Failed to save diagnostics log:', logError);
        }
        
        return results;
      }
      console.log(`✓ antcpt check passed (score: ${antcptScore}, required: ≥0.9)`);

      // Step 2: myadscenter check
      console.log(`=== Step 2: Checking My Ads Center for profile ${profileId} ===`);
      const adsCenterCheck = await this.checkAdsCenter(page, profileId, profile);
      const myadscenterPassed = !adsCenterCheck.needsFarming;
      results.myadscenterPassed = myadscenterPassed;
      results.logs.push({ step: 'myadscenter', passed: myadscenterPassed, reason: adsCenterCheck.reason });

      if (!myadscenterPassed) {
        console.log(`✗ Check FAILED: My Ads Center check failed (reason: ${adsCenterCheck.reason})`);
        console.log(`  - antcpt score: ${antcptScore}`);
        console.log(`  - My Ads Center: FAILED`);
        results.passed = false;
        
        // Save diagnostics result to InteractionLog for client viewing
        try {
          const log = new InteractionLog({
            profileId,
            action: 'diagnostics_check',
            url: 'https://myaccount.google.com/ads',
            success: false,
            error: `My Ads Center check failed (reason: ${adsCenterCheck.reason})`,
            metadata: { 
              step: 'myadscenter',
              antcptScore,
              myadscenterPassed: false,
              youtubePassed: false,
              reason: adsCenterCheck.reason,
              logs: results.logs
            }
          });
          await log.save();
        } catch (logError) {
          console.error('Failed to save diagnostics log:', logError);
        }
        
        return results;
      }
      console.log(`✓ My Ads Center check passed`);

      // Step 3: youtube check (skip if banned or no account)
      console.log(`=== Step 3: Checking YouTube for profile ${profileId} ===`);
      const isBanned = profile?.notes && profile.notes.includes('Banned Youtube');
      const hasNoAccount = profile?.notes && profile.notes.includes('No YouTube Account');
      
      if (isBanned) {
        console.log(`⚠ YouTube account is banned - skipping YouTube check`);
        results.youtubeBanned = true;
        results.youtubePassed = true; // Consider banned as "passed" for check purposes
        results.logs.push({ step: 'youtube', passed: true, reason: 'account_banned' });
      } else if (hasNoAccount) {
        console.log(`⚠ YouTube account does not exist (from DNA analysis) - skipping YouTube check`);
        results.youtubeBanned = false;
        results.youtubeNoAccount = true;
        results.youtubePassed = true; // Consider no account as "passed" for check purposes
        results.logs.push({ step: 'youtube', passed: true, reason: 'no_account' });
      } else {
        // checkShadowban returns true if shadowbanned, false if not shadowbanned
        // We want youtubePassed = true if NOT shadowbanned (check passed)
        const isShadowbanned = await this.checkShadowban(page, profileId);
        results.youtubePassed = !isShadowbanned; // Invert: passed if not shadowbanned
        results.logs.push({ step: 'youtube', passed: results.youtubePassed, shadowbanned: isShadowbanned });

        if (!results.youtubePassed) {
          console.log(`✗ Check FAILED: YouTube comment post failed (shadowbanned: ${isShadowbanned})`);
          console.log(`  - antcpt score: ${antcptScore}`);
          console.log(`  - My Ads Center: PASSED`);
          console.log(`  - YouTube: FAILED`);
          results.passed = false;
          
          // Save diagnostics result to InteractionLog for client viewing
          try {
            const log = new InteractionLog({
              profileId,
              action: 'diagnostics_check',
              url: 'https://www.youtube.com',
              success: false,
              error: `YouTube comment post failed (shadowbanned: ${isShadowbanned})`,
              metadata: { 
                step: 'youtube',
                antcptScore,
                myadscenterPassed: true,
                youtubePassed: false,
                shadowbanned: isShadowbanned,
                logs: results.logs
              }
            });
            await log.save();
          } catch (logError) {
            console.error('Failed to save diagnostics log:', logError);
          }
          
          return results;
        }
        console.log(`✓ YouTube check passed`);
      }

      // All checks passed
      console.log(`✓ Check PASSED: Account is ready`);
      console.log(`  - antcpt score: ${antcptScore}`);
      console.log(`  - My Ads Center: PASSED`);
      const youtubeStatus = isBanned ? 'BANNED (skipped)' : hasNoAccount ? 'NO ACCOUNT (skipped)' : 'PASSED';
      console.log(`  - YouTube: ${youtubeStatus}`);
      results.passed = true;

      // Save diagnostics result to InteractionLog for client viewing
      try {
        const log = new InteractionLog({
          profileId,
          action: 'diagnostics_check',
          url: 'https://antcpt.com/score_detector/',
          success: true,
          metadata: { 
            step: 'all_passed',
            antcptScore,
            myadscenterPassed: true,
            youtubePassed: results.youtubePassed,
            youtubeBanned: results.youtubeBanned,
            youtubeNoAccount: results.youtubeNoAccount,
            logs: results.logs
          }
        });
        await log.save();
        console.log('✓ Diagnostics log saved to InteractionLog');
      } catch (logError) {
        console.error('Failed to save diagnostics log:', logError);
      }

      // Save trust score for passed accounts
      try {
        const trustScore = new TrustScore({
          profileId,
          score: antcptScore,
          source: 'antcpt',
          metadata: {
            timestamp: new Date(),
            antcptScore,
            myadscenterPassed,
            youtubePassed: results.youtubePassed,
            youtubeBanned: results.youtubeBanned,
            checkPassed: true
          }
        });
        await trustScore.save();
        console.log('✓ Trust score saved to TrustScore collection');

        await Profile.updateTrustScore(profileId, antcptScore);
        console.log('✓ Profile trust score updated');
      } catch (saveError) {
        console.error('✗ Error saving trust score:', saveError);
      }

      return results;
    } catch (error) {
      console.error(`Doctor diagnostics error for profile ${profileId}:`, error);
      results.logs.push({ step: 'error', error: error.message });
      throw error;
    } finally {
      try {
        await this.adspower.closeAllTabsAndStopProfile(profileId, browser);
      } catch (stopError) {
        console.warn(`⚠ Failed to close tabs and stop profile ${profileId}:`, stopError.message);
        // Fallback: try to disconnect and stop separately
      if (browser) {
          try {
        await browser.disconnect();
          } catch (disconnectError) {
            // Ignore
          }
        }
        try {
          await this.adspower.stopProfile(profileId);
        } catch (stopError2) {
          // Ignore
        }
      }
    }
  }

  calculateCompositeTrustScore(factors) {
    const { antcptScore, personaIntegrity, shadowbanned, adsCenterIssue } = factors;
    
    let baseScore = antcptScore || 0;
    
    const weights = {
      antcpt: 0.5,
      personaIntegrity: 0.25,
      shadowban: 0.15,
      adsCenter: 0.10
    };
    
    let compositeScore = baseScore * weights.antcpt;
    
    if (personaIntegrity) {
      compositeScore += 1.0 * weights.personaIntegrity;
    } else {
      compositeScore += 0.0;
    }
    
    if (!shadowbanned) {
      compositeScore += 1.0 * weights.shadowban;
    } else {
      compositeScore += 0.0;
    }
    
    if (!adsCenterIssue) {
      compositeScore += 1.0 * weights.adsCenter;
    } else {
      compositeScore += 0.0;
    }
    
    const finalScore = Math.min(1.0, Math.max(0.0, compositeScore));
    
    console.log(`=== Composite Trust Score Calculation ===`);
    console.log(`Antcpt Score: ${antcptScore || 'N/A'} (weight: ${weights.antcpt})`);
    console.log(`Persona Integrity: ${personaIntegrity ? 'Pass' : 'Fail'} (weight: ${weights.personaIntegrity})`);
    console.log(`Shadowban Status: ${shadowbanned ? 'Shadowbanned' : 'Not Shadowbanned'} (weight: ${weights.shadowban})`);
    console.log(`Ads Center: ${adsCenterIssue ? 'Issue Detected' : 'OK'} (weight: ${weights.adsCenter})`);
    console.log(`Composite Score: ${(finalScore * 100).toFixed(2)}%`);
    
    return finalScore;
  }

  async checkTrustScore(page, profileId) {
    try {
      console.log(`Navigating to antcpt.com/score_detector/ for profile ${profileId}...`);
      await page.goto('https://antcpt.com/score_detector/', { waitUntil: 'networkidle2', timeout: 30000 });
      await HumanEmulation.randomDelay(3000, 5000);

      await HumanEmulation.simulateReading(page, 2000);
      
      // Wait for the score to appear (the page might need time to calculate)
      console.log('Waiting for score to be calculated...');
      try {
        // Wait for any element that might contain the score
        await page.waitForSelector('body', { timeout: 10000 });
        await page.waitForTimeout(8000); // Give the page more time to calculate
      } catch (waitError) {
        console.log('Wait timeout, proceeding anyway:', waitError.message);
      }
      
      // Take a screenshot for debugging
      try {
        await page.screenshot({ path: `trust-score-debug-${profileId}.png`, fullPage: true });
        console.log(`Screenshot saved: trust-score-debug-${profileId}.png`);
      } catch (screenshotError) {
        console.log('Could not take screenshot:', screenshotError.message);
      }

      const score = await page.evaluate(() => {
        // Get all text content for debugging
        const bodyText = document.body.textContent || document.body.innerText || '';
        console.log('Page body text sample:', bodyText.substring(0, 500));
        
        // Try multiple strategies to find the score
        const strategies = [
          // Strategy 1: Look for common score class/id patterns
          () => {
            const selectors = [
              '.score',
              '#score',
              '[class*="score"]',
              '[id*="score"]',
              '[class*="Score"]',
              '[id*="Score"]',
              '[class*="result"]',
              '[id*="result"]',
              '[class*="Result"]',
              '[id*="Result"]',
              '.detector-score',
              '#detector-score',
              '[data-score]'
            ];
            
            for (const selector of selectors) {
              const elements = document.querySelectorAll(selector);
              for (const el of elements) {
                const text = (el.textContent || el.innerText || '').trim();
                const value = el.getAttribute('data-score') || el.getAttribute('value');
                
                if (value) {
                  const num = parseFloat(value);
                  if (!isNaN(num) && num >= 0 && num <= 100) {
                    return num > 1 ? num / 100 : num;
                  }
                }
                
                // Look for percentage or decimal in text
                const percentMatch = text.match(/(\d+\.?\d*)\s*%/);
                const decimalMatch = text.match(/(0?\.\d+|\d+\.\d+)/);
                
                if (percentMatch) {
                  return parseFloat(percentMatch[1]) / 100;
                } else if (decimalMatch) {
                  const decimal = parseFloat(decimalMatch[1]);
                  return decimal > 1 ? decimal / 100 : decimal;
                }
              }
            }
            return null;
          },
          
          // Strategy 2: Search all elements for score-like text
          () => {
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
              const text = (el.textContent || el.innerText || '').trim();
              // Look for patterns like "Score: 85%" or "85%" or "0.85"
              if (text.length < 50 && /score|result/i.test(text)) {
                const percentMatch = text.match(/(\d+\.?\d*)\s*%/);
                const decimalMatch = text.match(/(0?\.\d+|\d+\.\d+)/);
                
                if (percentMatch) {
                  return parseFloat(percentMatch[1]) / 100;
                } else if (decimalMatch) {
                  const decimal = parseFloat(decimalMatch[1]);
                  return decimal > 1 ? decimal / 100 : decimal;
                }
              }
            }
            return null;
          },
          
          // Strategy 3: Search entire body text for percentage patterns
          () => {
            const bodyText = document.body.textContent || document.body.innerText || '';
            // Look for patterns like "85%" or "Score: 85" or "0.85"
            const patterns = [
              /score[:\s]*(\d+\.?\d*)\s*%/i,
              /(\d+\.?\d*)\s*%/,
              /score[:\s]*(\d+\.?\d*)/i,
              /(0?\.\d+|\d+\.\d+)/,
              /(\d+)\s*out\s*of\s*100/i,
              /(\d+)\s*\/\s*100/
            ];
            
            for (const pattern of patterns) {
              const match = bodyText.match(pattern);
              if (match) {
                const num = parseFloat(match[1]);
                if (!isNaN(num) && num >= 0) {
                  // If it's a percentage (0-100), convert to decimal
                  if (num > 1 && num <= 100) {
                    return num / 100;
                  }
                  // If it's already a decimal (0-1), return as is
                  if (num >= 0 && num <= 1) {
                    return num;
                  }
                }
              }
            }
            return null;
          },
          
          // Strategy 4: Look for large numbers that might be scores
          () => {
            const allText = document.body.textContent || '';
            // Find all numbers between 0 and 100
            const numberMatches = allText.match(/\b(\d{1,2}(?:\.\d+)?)\b/g);
            if (numberMatches) {
              for (const match of numberMatches) {
                const num = parseFloat(match);
                // If it's between 0-100, it's likely a percentage score
                if (num >= 0 && num <= 100 && num % 1 !== 0 || (num >= 10 && num <= 100)) {
                  return num / 100;
                }
              }
            }
            return null;
          }
        ];
        
        // Try each strategy
        for (const strategy of strategies) {
          try {
            const result = strategy();
            if (result !== null && !isNaN(result) && result >= 0 && result <= 1) {
              return result;
            }
          } catch (e) {
            // Continue to next strategy
          }
        }
        
        return null;
      });

      console.log(`Trust score extracted from page: ${score} (type: ${typeof score})`);
      
      // If score is still null, log page info for debugging
      if (score === null) {
        const pageInfo = await page.evaluate(() => {
          return {
            url: window.location.href,
            title: document.title,
            bodyText: document.body.textContent.substring(0, 1000),
            allText: document.body.innerText.substring(0, 1000),
            elementsWithScore: Array.from(document.querySelectorAll('[class*="score"], [id*="score"], [class*="Score"], [id*="Score"]')).map(el => ({
              tag: el.tagName,
              class: el.className,
              id: el.id,
              text: el.textContent.substring(0, 100)
            }))
          };
        });
        console.log('Page info when score is null:', JSON.stringify(pageInfo, null, 2));
      }

      if (score !== null && !isNaN(score) && score > 0) {
        console.log(`=== Saving trust score for profile ${profileId} ===`);
        console.log(`Trust score value: ${score} (type: ${typeof score})`);
        
        try {
        const trustScore = new TrustScore({
          profileId,
          score,
          source: 'antcpt',
          metadata: { timestamp: new Date() }
        });
        await trustScore.save();
          console.log('✓ Trust score saved to TrustScore collection');

        try {
          const log = new InteractionLog({
            profileId,
            action: 'trust_score_check',
            url: 'https://antcpt.com/score_detector/',
            success: true,
              metadata: { score, source: 'antcpt' }
          });
          await log.save();
            console.log('✓ Interaction log saved');
        } catch (logError) {
            console.error('✗ Failed to save trust score log:', logError);
          }
        } catch (saveError) {
          console.error('✗ Error saving antcpt score:', saveError);
          console.error('Error details:', {
            message: saveError.message,
            stack: saveError.stack,
            profileId: profileId,
            score: score
          });
          throw saveError;
        }
      } else {
        console.log(`⚠ Trust score is null, invalid, or zero: ${score}`);
        console.log(`  - score: ${score}`);
        console.log(`  - isNaN: ${isNaN(score)}`);
        console.log(`  - score > 0: ${score > 0}`);
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

  async checkAdsCenter(page, profileId, profile) {
    try {
      const ageBracket = profile.persona?.ageBracket || profile.notes?.match(/\|\s*(\d+-\d+)\s*\|/)?.[1] || '';
      
      if (!ageBracket) {
        console.log('No age bracket found in profile, skipping Ads Center check');
        return { needsFarming: false, reason: 'no_age_data' };
      }
      
      const ageMatch = ageBracket.match(/(\d+)-(\d+)/);
      if (!ageMatch) {
        console.log(`Could not parse age bracket: ${ageBracket}`);
        return { needsFarming: false, reason: 'invalid_age_format' };
      }
      
      const minAge = parseInt(ageMatch[1]);
      const maxAge = parseInt(ageMatch[2]);
      
      if (minAge < 18) {
        console.log(`Age bracket ${ageBracket} is under 18, skipping Ads Center check`);
        return { needsFarming: false, reason: 'under_18' };
      }
      
      console.log(`Age bracket ${ageBracket} is 18+, checking My Ads Center...`);
      
      try {
        // Navigate directly to English version to prevent Google Translate redirect
        await page.goto('https://adssettings.google.com/authenticated?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
        await HumanEmulation.randomDelay(3000, 5000);
        
        // Check if we were redirected to Google Translate
        const currentUrl = page.url();
        const isTranslatePage = currentUrl.includes('translate.google.com') || 
                                currentUrl.includes('translate.googleapis.com') ||
                                await page.evaluate(() => {
                                  const bodyText = document.body?.textContent?.toLowerCase() || '';
                                  const title = document.title?.toLowerCase() || '';
                                  return bodyText.includes('google translate') || 
                                         title.includes('google translate') ||
                                         document.querySelector('[id*="translate"], [class*="translate"]') !== null;
                                });
        
        if (isTranslatePage) {
          console.log('⚠ Detected Google Translate redirect, closing translate banner and navigating to English version...');
          
          // Try to close translate banner if present
          try {
            await page.evaluate(() => {
              // Look for close button in translate banner
              const closeButtons = Array.from(document.querySelectorAll('button, [role="button"], a'));
              const closeBtn = closeButtons.find(btn => {
                const text = (btn.textContent || '').toLowerCase();
                const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                return text === '×' || text === '✕' || text === 'x' ||
                       ariaLabel.includes('close') || ariaLabel.includes('dismiss') ||
                       btn.id?.includes('close') || btn.className?.includes('close');
              });
              if (closeBtn) {
                closeBtn.click();
              }
            });
            await HumanEmulation.randomDelay(1000, 2000);
          } catch (closeError) {
            console.log('Could not close translate banner:', closeError.message);
          }
          
          // Navigate directly to English version
          try {
            await page.goto('https://adssettings.google.com/authenticated?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
            await HumanEmulation.randomDelay(2000, 3000);
            console.log('✓ Navigated to English version of My Ads Center');
          } catch (navError) {
            console.log(`⚠ Could not navigate to English version: ${navError.message}`);
          }
        }
        
        // Check if page is in non-English language (after handling translate redirect)
        const pageLanguage = await page.evaluate(() => {
          const htmlLang = document.documentElement.getAttribute('lang');
          const bodyText = document.body?.textContent?.toLowerCase() || '';
          // Check for common non-English indicators
          if (htmlLang && !htmlLang.toLowerCase().startsWith('en')) {
            return htmlLang.split('-')[0];
          }
          // Check for Spanish text patterns
          if (bodyText.includes('menores de 18') || bodyText.includes('niños y adolescentes')) {
            return 'es';
          }
          return 'en';
        });
        
        // If page is still not in English, try to force English
        if (pageLanguage !== 'en' && !isTranslatePage) {
          console.log(`⚠ My Ads Center page is in ${pageLanguage}, forcing English version...`);
          try {
            await page.goto('https://adssettings.google.com/authenticated?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
            await HumanEmulation.randomDelay(2000, 3000);
            console.log('✓ Forced English version');
          } catch (forceError) {
            console.log(`⚠ Could not force English version: ${forceError.message}, checking in original language...`);
          }
        }
        
        const under18Message = await page.evaluate(() => {
          const bodyText = document.body.textContent || '';
          const lowerText = bodyText.toLowerCase();
          
          // English patterns
          const englishPatterns = [
            "google doesn't show personalized ads to anyone under 18",
            "doesn't show personalized ads to anyone under 18",
            "personalized ads to anyone under 18",
            "personalized ads to users under 18",
            "show personalized ads to anyone under 18"
          ];
          
          // Spanish patterns (original language detection)
          const spanishPatterns = [
            "google no muestra anuncios personalizados a usuarios menores de 18",
            "no muestra anuncios personalizados a usuarios menores de 18",
            "anuncios personalizados a usuarios menores de 18",
            "menores de 18 años",
            "niños y adolescentes pueden aprender sobre anuncios"
          ];
          
          // Check for English patterns
          const hasEnglishPattern = englishPatterns.some(pattern => lowerText.includes(pattern));
          
          // Check for Spanish patterns
          const hasSpanishPattern = spanishPatterns.some(pattern => lowerText.includes(pattern));
          
          // Also check for generic patterns (works in multiple languages)
          const hasGenericPattern = (lowerText.includes("under 18") || lowerText.includes("menores de 18") || lowerText.includes("under 18 years")) &&
                                   (lowerText.includes("personalized ads") || lowerText.includes("anuncios personalizados") || lowerText.includes("personalized"));
          
          return hasEnglishPattern || hasSpanishPattern || hasGenericPattern;
        });
        
        if (under18Message) {
          console.log(`✗ My Ads Center shows under-18 message for 18+ account - needs farming`);
          return { needsFarming: true, reason: 'under_18_message_shown' };
        } else {
          console.log(`✓ My Ads Center does not show under-18 message`);
          return { needsFarming: false, reason: 'no_under_18_message' };
        }
      } catch (adsCenterError) {
        console.warn(`Failed to check My Ads Center: ${adsCenterError.message}`);
        return { needsFarming: false, reason: 'check_failed', error: adsCenterError.message };
      }
    } catch (error) {
      console.error('Ads Center check error:', error);
      return { needsFarming: false, reason: 'error', error: error.message };
    }
  }

  async handleYouTubePopups(page) {
    try {
      // Handle "Remember that anyone can see what you write" modal (appears when posting comments)
      // This modal appears frequently when Google flags accounts
      const understoodButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => {
          const text = (btn.textContent || '').toLowerCase();
          return text.includes('understood') || 
                 (text.includes('remember') && text.includes('anyone') && text.includes('see'));
        });
      });
      
      if (understoodButton && understoodButton.asElement()) {
        const isVisible = await understoodButton.asElement().evaluate(el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && 
                 style.display !== 'none' && 
                 style.visibility !== 'hidden' &&
                 el.offsetParent !== null;
        });
        if (isVisible) {
          console.log('Found "Remember that anyone can see" modal, clicking Understood...');
          await understoodButton.asElement().click({ delay: 100 });
          await HumanEmulation.randomDelay(1000, 2000);
          return; // Return early after handling this modal
        }
      }

      // Handle notification permission pop-up
      const notificationBlockButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => {
          const text = (btn.textContent || '').toLowerCase();
          return text.includes('block') || 
                 (text.includes('notifications') && (text.includes('block') || text.includes('deny')));
        });
      });
      
      if (notificationBlockButton && notificationBlockButton.asElement()) {
        const isVisible = await notificationBlockButton.asElement().evaluate(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (isVisible) {
          console.log('Found notification pop-up, clicking Block...');
          await notificationBlockButton.asElement().click({ delay: 100 });
          await HumanEmulation.randomDelay(1000, 2000);
        }
      }

      // Handle YouTube Premium pop-up
      const premiumDismissButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button, a'));
        return buttons.find(btn => {
          const text = (btn.textContent || '').toLowerCase();
          return text.includes('no, gracias') || 
                 text.includes('no thanks') || 
                 text.includes('not now') ||
                 text.includes('skip') ||
                 (text.includes('premium') && (text.includes('no') || text.includes('skip')));
        });
      });
      
      if (premiumDismissButton && premiumDismissButton.asElement()) {
        const isVisible = await premiumDismissButton.asElement().evaluate(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (isVisible) {
          console.log('Found YouTube Premium pop-up, dismissing...');
          await premiumDismissButton.asElement().click({ delay: 100 });
          await HumanEmulation.randomDelay(1000, 2000);
        }
      }

      // Also try to close any pop-ups with X button
      const closeButtons = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button, [aria-label*="close" i], [aria-label*="dismiss" i]'));
        return buttons.find(btn => {
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const text = (btn.textContent || '').toLowerCase();
          return ariaLabel.includes('close') || 
                 ariaLabel.includes('dismiss') ||
                 text === '×' ||
                 text === '✕' ||
                 btn.classList.contains('close') ||
                 btn.id.includes('close');
        });
      });
      
      if (closeButtons && closeButtons.asElement()) {
        const isVisible = await closeButtons.asElement().evaluate(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && 
                 window.getComputedStyle(el).display !== 'none';
        });
        if (isVisible) {
          console.log('Found close button, clicking...');
          await closeButtons.asElement().click({ delay: 100 });
          await HumanEmulation.randomDelay(500, 1000);
        }
      }
    } catch (error) {
      // Silently ignore pop-up handling errors
      console.log('Error handling YouTube pop-ups:', error.message);
    }
  }

  async checkShadowban(page, profileId) {
    try {
      // Check if profile has "Banned Youtube" in notes - skip YouTube check if so
      const profile = await Profile.findById(profileId);
      if (profile && profile.notes && profile.notes.includes('Banned Youtube')) {
        console.log(`⚠ Profile ${profileId} has "Banned Youtube" in notes - skipping YouTube shadowban check`);
        return false; // Return false (not shadowbanned) to avoid affecting trust score
      }

      const testVideoUrl = 'https://www.youtube.com/watch?v=TtPXvEcE11E';
      await page.goto(testVideoUrl, { waitUntil: 'networkidle2' });
      await HumanEmulation.randomDelay(3000, 5000);

      // Handle YouTube pop-ups immediately after page load
      await this.handleYouTubePopups(page);

      // Extract video information for AI comment generation
      let videoTitle = '';
      let videoDescription = '';
      try {
        const videoInfo = await page.evaluate(() => {
          const titleElement = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title, ytd-watch-metadata h1, h1[class*="title"]');
          const descriptionElement = document.querySelector('#description, #description-text, ytd-expander #content, ytd-video-secondary-info-renderer #description');
          
          return {
            title: titleElement ? titleElement.textContent.trim() : '',
            description: descriptionElement ? descriptionElement.textContent.trim().substring(0, 1000) : ''
          };
        });
        videoTitle = videoInfo.title || '';
        videoDescription = videoInfo.description || '';
        console.log(`Video title: ${videoTitle.substring(0, 100)}`);
        if (videoDescription) {
          console.log(`Video description: ${videoDescription.substring(0, 200)}...`);
        }
      } catch (videoInfoError) {
        console.warn('Could not extract video info:', videoInfoError.message);
      }

      // Check for banned channel indicators before proceeding
      const isBanned = await page.evaluate(() => {
        const bodyText = document.body.textContent || document.body.innerText || '';
        const lowerText = bodyText.toLowerCase();
        
        // Check for various banned channel indicators
        return lowerText.includes('this channel has been terminated') ||
               lowerText.includes('this account has been suspended') ||
               lowerText.includes('this channel is no longer available') ||
               lowerText.includes('channel terminated') ||
               lowerText.includes('account suspended') ||
               lowerText.includes('channel suspended') ||
               lowerText.includes('this account has been disabled') ||
               lowerText.includes('channel has been disabled') ||
               lowerText.includes('violation of community guidelines') ||
               (lowerText.includes('banned') && lowerText.includes('channel')) ||
               (lowerText.includes('terminated') && lowerText.includes('youtube'));
      });

      if (isBanned) {
        console.log(`✗ YouTube channel is banned for profile ${profileId}`);
        
        // Update profile notes with "Banned Youtube"
        const currentNotes = profile?.notes || '';
        const bannedNote = currentNotes.includes('Banned Youtube') 
          ? currentNotes 
          : currentNotes 
            ? `${currentNotes} | Banned Youtube`
            : 'Banned Youtube';
        
        await Profile.update(profileId, { notes: bannedNote });
        console.log(`✓ Updated profile ${profileId} notes with "Banned Youtube"`);
        
        try {
          const log = new InteractionLog({
            profileId,
            action: 'youtube_ban_detection',
            url: testVideoUrl,
            success: true,
            metadata: { banned: true, reason: 'Channel banned detected' }
          });
          await log.save();
        } catch (logError) {
          console.error('Failed to save ban detection log:', logError);
        }
        
        // Return false (not shadowbanned) since we're skipping the check
        return false;
      }

      // Generate AI-powered comment based on video content and profile persona
      let commentText = '';
      try {
        const profile = await Profile.findById(profileId);
        const persona = profile?.persona || {};
        commentText = await generateYouTubeComment(videoTitle, videoDescription, persona);
        console.log(`✓ Generated AI comment: ${commentText}`);
      } catch (aiError) {
        console.warn('Failed to generate AI comment, using fallback:', aiError.message);
        // Fallback to a more natural-sounding comment if AI fails
        commentText = `This is really helpful, thanks for sharing!`;
      }
      
      // Scroll down gradually to trigger lazy loading
      console.log('Scrolling to load comments section...');
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => {
          window.scrollBy(0, window.innerHeight);
        });
        await HumanEmulation.randomDelay(1000, 1500);
      }
      
      // Scroll to bottom to ensure comments are loaded
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await HumanEmulation.randomDelay(3000, 4000);
      
      // Handle YouTube pop-ups after scrolling (they might appear)
      await this.handleYouTubePopups(page);
      
      // Check if comments section exists and try to expand it
      try {
        // Look for "Show comments" or "Load comments" button
        const showCommentsButton = await page.evaluateHandle(() => {
          const buttons = Array.from(document.querySelectorAll('button, a, ytd-button-renderer'));
          return buttons.find(btn => {
            const text = (btn.textContent || '').toLowerCase();
            return text.includes('show comments') || 
                   text.includes('load comments') ||
                   text.includes('view comments') ||
                   (text.includes('comments') && text.includes('show'));
          });
        });
        
        if (showCommentsButton && showCommentsButton.asElement()) {
          console.log('Found "Show comments" button, clicking...');
          await showCommentsButton.asElement().click({ delay: 100 });
          await HumanEmulation.randomDelay(3000, 5000);
          
          // Handle pop-ups after clicking show comments
          await this.handleYouTubePopups(page);
        }
      } catch (e) {
        console.log('No "Show comments" button found or already expanded');
      }
      
      // Wait for comments section to load
      try {
        await page.waitForSelector('ytd-comments, #comments, ytd-commentbox, ytd-comments-header-renderer', { timeout: 15000 });
        console.log('✓ Comments section loaded');
      } catch (e) {
        console.log('Comments section not found after waiting, checking if comments are disabled or channel is banned...');
        
        // Check for banned channel again (might appear after navigation)
        const isBannedAfterNav = await page.evaluate(() => {
          const bodyText = document.body.textContent || document.body.innerText || '';
          const lowerText = bodyText.toLowerCase();
          return lowerText.includes('this channel has been terminated') ||
                 lowerText.includes('this account has been suspended') ||
                 lowerText.includes('this channel is no longer available') ||
                 lowerText.includes('channel terminated') ||
                 lowerText.includes('account suspended') ||
                 lowerText.includes('channel suspended');
        });
        
        if (isBannedAfterNav) {
          console.log(`✗ YouTube channel is banned for profile ${profileId} (detected after navigation)`);
          const currentProfile = await Profile.findById(profileId);
          const currentNotes = currentProfile?.notes || '';
          const bannedNote = currentNotes.includes('Banned Youtube') 
            ? currentNotes 
            : currentNotes 
              ? `${currentNotes} | Banned Youtube`
              : 'Banned Youtube';
          await Profile.update(profileId, { notes: bannedNote });
          console.log(`✓ Updated profile ${profileId} notes with "Banned Youtube"`);
          return false;
        }
        
        // Check if comments are disabled
        const commentsDisabled = await page.evaluate(() => {
          const bodyText = document.body.textContent.toLowerCase();
          return bodyText.includes('comments are turned off') || 
                 bodyText.includes('comments disabled') ||
                 bodyText.includes('the creator has disabled comments');
        });
        if (commentsDisabled) {
          throw new Error('Comments are disabled on this video');
        }
      }
      
      // Scroll to comments section again after expansion
      await page.evaluate(() => {
        const commentsSection = document.querySelector('ytd-comments, #comments');
        if (commentsSection) {
          commentsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          window.scrollTo(0, document.body.scrollHeight);
        }
      });
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Handle pop-ups before trying to find comment box
      await this.handleYouTubePopups(page);
      
      // Try to find comment box with multiple strategies
      let commentBox = null;
      let commentSelector = null;
      
      // Strategy 1: Wait for comment box to appear with longer timeout
      const commentBoxSelectors = [
        'ytd-commentbox #contenteditable-root',
        'ytd-commentbox #placeholder-area',
        'ytd-comment-simplebox-text-input #contenteditable-root',
        'ytd-comment-simplebox-text-input #placeholder-area',
        '#comment-dialog #contenteditable-root',
        '#contenteditable-root',
        '#placeholder-area',
        'div[contenteditable="true"][id*="contenteditable"]',
        'div[contenteditable="true"][placeholder*="comment" i]',
        'div[contenteditable="true"][aria-label*="comment" i]'
      ];
      
      for (const selector of commentBoxSelectors) {
        try {
          console.log(`Trying selector: ${selector}`);
          await page.waitForSelector(selector, { timeout: 8000, visible: true });
          commentBox = await page.$(selector);
          if (commentBox) {
            const isVisible = await commentBox.evaluate(el => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              const inViewport = rect.top >= 0 && rect.left >= 0 && 
                               rect.bottom <= (window.innerHeight + 200) && 
                               rect.right <= (window.innerWidth + 200);
              return rect.width > 0 && rect.height > 0 && 
                     style.display !== 'none' && 
                     style.visibility !== 'hidden' &&
                     el.offsetParent !== null &&
                     inViewport;
            });
            if (isVisible) {
              commentSelector = selector;
              console.log(`✓ Found comment box with selector: ${selector}`);
              break;
            } else {
              console.log(`Element found but not visible/in viewport: ${selector}`);
            }
          }
        } catch (e) {
          console.log(`Selector failed: ${selector} - ${e.message}`);
          continue;
        }
      }
      
      // Strategy 2: Find by evaluating page
      if (!commentBox) {
        console.log('Trying to find comment box by evaluating page...');
        const foundElement = await page.evaluateHandle(() => {
          // Find all contenteditable divs
          const allEditable = Array.from(document.querySelectorAll('div[contenteditable="true"]'));
          
          for (const el of allEditable) {
            const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
            const id = (el.id || '').toLowerCase();
            const className = (el.className || '').toLowerCase();
            const parent = el.closest('ytd-commentbox, #comment-dialog, form');
            
            // Check if it's likely a comment box
            if (placeholder.includes('comment') || 
                ariaLabel.includes('comment') ||
                id.includes('contenteditable') ||
                id.includes('placeholder') ||
                className.includes('comment') ||
                parent !== null) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return el;
              }
            }
          }
          return null;
        });
        
        if (foundElement && foundElement.asElement()) {
          commentBox = foundElement.asElement();
          console.log('✓ Found comment box by page evaluation');
        }
      }
      
      if (commentBox) {
        try {
          // Scroll element into view
          await commentBox.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          await HumanEmulation.randomDelay(1000, 2000);
          
          // Try to click using selector first (more reliable)
          if (commentSelector) {
            try {
              await page.click(commentSelector, { delay: 100 });
            } catch (clickError) {
              // If selector click fails, try element click
              try {
                await commentBox.click({ delay: 100 });
              } catch (elementClickError) {
                // If both fail, try JavaScript click
                await commentBox.evaluate(el => {
                  el.focus();
                  el.click();
                });
              }
            }
          } else {
            // Try element click, fallback to JavaScript
            try {
              await commentBox.click({ delay: 100 });
            } catch (clickError) {
              await commentBox.evaluate(el => {
                el.focus();
                el.click();
              });
            }
          }
          
          await HumanEmulation.randomDelay(500, 1000);
          
          // Type comment - use selector if available, otherwise direct typing
          if (commentSelector) {
            try {
              // First ensure element is focused and ready
              await page.evaluate((selector) => {
                const el = document.querySelector(selector);
                if (el) {
                  el.focus();
                  el.click();
                }
              }, commentSelector);
              await HumanEmulation.randomDelay(200, 400);
              
              // Try humanType, but catch errors
              try {
                await HumanEmulation.humanType(page, commentSelector, commentText);
              } catch (typeError) {
                // Fallback to direct typing via element
                await commentBox.type(commentText, { delay: 50 });
              }
            } catch (typeError) {
              // Fallback to direct typing
              await commentBox.type(commentText, { delay: 50 });
            }
          } else {
            // Direct typing on element
            try {
              await commentBox.type(commentText, { delay: 50 });
            } catch (typeError) {
              // Last resort: set text via JavaScript
              await commentBox.evaluate((el, text) => {
                el.focus();
                el.textContent = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }, commentText);
            }
          }
          await HumanEmulation.randomDelay(1000, 2000);
          
          // Handle pop-ups before submitting comment
          await this.handleYouTubePopups(page);
        } catch (interactionError) {
          console.error('Error interacting with comment box:', interactionError.message);
          // Try alternative approach - use page.evaluate to set value directly
          try {
            await commentBox.evaluate((el, text) => {
              el.focus();
              el.textContent = text;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, commentText);
        await HumanEmulation.randomDelay(1000, 2000);
          } catch (evalError) {
            console.error('Failed to set comment text:', evalError.message);
            throw new Error('Could not interact with comment box');
          }
        }
        
        // Find and click submit button
        const submitSelectors = [
          'button[aria-label*="Comment" i]',
          'button[id="submit-button"]',
          'button[id*="submit"]',
          'button[aria-label*="Post" i]',
          'ytd-button-renderer button',
          '#submit-button'
        ];
        
        let submitButton = null;
        for (const selector of submitSelectors) {
          try {
            submitButton = await page.$(selector);
        if (submitButton) {
              const isVisible = await submitButton.evaluate(el => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 &&
                       style.display !== 'none' &&
                       style.visibility !== 'hidden' &&
                       el.offsetParent !== null;
              });
              if (isVisible) {
                console.log(`✓ Found submit button: ${selector}`);
                await submitButton.click({ delay: 100 });
                await HumanEmulation.randomDelay(2000, 3000);
                
                // Handle "Remember that anyone can see" modal that appears after clicking submit
                await this.handleYouTubePopups(page);
                
                await HumanEmulation.randomDelay(3000, 4000);
                console.log('✓ Comment submitted');
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        if (!submitButton) {
          console.log('⚠ Submit button not found, trying Enter key');
          await page.keyboard.press('Enter');
          await HumanEmulation.randomDelay(2000, 3000);
          
          // Handle modal that might appear after Enter
          await this.handleYouTubePopups(page);
          
          await HumanEmulation.randomDelay(1000, 2000);
        }
      } else {
        // Check if channel is banned before reporting comment box not found
        const isBannedBeforeComment = await page.evaluate(() => {
          const bodyText = document.body.textContent || document.body.innerText || '';
          const lowerText = bodyText.toLowerCase();
          return lowerText.includes('this channel has been terminated') ||
                 lowerText.includes('this account has been suspended') ||
                 lowerText.includes('this channel is no longer available') ||
                 lowerText.includes('channel terminated') ||
                 lowerText.includes('account suspended') ||
                 lowerText.includes('channel suspended') ||
                 lowerText.includes('this account has been disabled');
        });
        
        if (isBannedBeforeComment) {
          console.log(`✗ YouTube channel is banned for profile ${profileId} (detected when comment box not found)`);
          const currentProfile = await Profile.findById(profileId);
          const currentNotes = currentProfile?.notes || '';
          const bannedNote = currentNotes.includes('Banned Youtube') 
            ? currentNotes 
            : currentNotes 
              ? `${currentNotes} | Banned Youtube`
              : 'Banned Youtube';
          await Profile.update(profileId, { notes: bannedNote });
          console.log(`✓ Updated profile ${profileId} notes with "Banned Youtube"`);
          return false;
        }
        
        console.error('✗ Comment box not detected after all attempts');
        console.log('Page URL:', page.url());
        console.log('Trying to take screenshot for debugging...');
        try {
          await page.screenshot({ path: 'youtube-comment-debug.png' });
          console.log('Screenshot saved as youtube-comment-debug.png');
        } catch (e) {
          console.log('Could not take screenshot:', e.message);
        }
      }

      console.log('Waiting for comment to be processed by YouTube...');
      await HumanEmulation.randomDelay(20000, 30000);

      // Verify comment visibility using headless/incognito browser
      let commentVisible = false;
      let verificationFailed = false;
      try {
        console.log('Opening headless browser to verify comment visibility...');
        const puppeteer = await import('puppeteer');
        const headlessBrowser = await puppeteer.launch({
          headless: true,
          args: ['--incognito', '--no-sandbox', '--disable-setuid-sandbox']
        });
        const headlessPage = await headlessBrowser.newPage();
        
        await headlessPage.goto(testVideoUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await HumanEmulation.randomDelay(5000, 7000);
        
        // Scroll down gradually to load comments section
        console.log('Scrolling to load comments section in verification browser...');
        for (let i = 0; i < 5; i++) {
          await headlessPage.evaluate(() => {
            window.scrollBy(0, window.innerHeight);
          });
          await HumanEmulation.randomDelay(1000, 1500);
        }
        
        // Scroll to bottom to ensure comments are loaded
        await headlessPage.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await HumanEmulation.randomDelay(3000, 5000);
        
        // Try to expand comments section if needed
        try {
          const showCommentsButton = await headlessPage.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button, a, ytd-button-renderer'));
            return buttons.find(btn => {
              const text = (btn.textContent || '').toLowerCase();
              return text.includes('show comments') || 
                     text.includes('load comments') ||
                     text.includes('view comments');
            });
          });
          
          if (showCommentsButton && showCommentsButton.asElement()) {
            console.log('Found "Show comments" button in verification, clicking...');
            await showCommentsButton.asElement().click({ delay: 100 });
            await HumanEmulation.randomDelay(3000, 5000);
          }
        } catch (e) {
          console.log('No "Show comments" button found in verification');
        }
        
        // Wait for comments to load
        try {
          await headlessPage.waitForSelector('ytd-comments, #comments, ytd-comment-thread-renderer', { timeout: 10000 });
          console.log('✓ Comments section loaded in verification browser');
        } catch (e) {
          console.log('Comments section not found in verification, continuing anyway...');
        }
        
        // Try to sort comments by "Newest first" to see recent comments
        console.log('Attempting to sort comments by newest first...');
        try {
          const sortButton = await headlessPage.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button, ytd-button-renderer, a'));
            return buttons.find(btn => {
              const text = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
              return text.includes('sort') || 
                     text.includes('newest') || 
                     text.includes('recent') ||
                     text.includes('latest');
            });
          });
          
          if (sortButton && sortButton.asElement()) {
            await sortButton.asElement().click({ delay: 100 });
            await HumanEmulation.randomDelay(2000, 3000);
            
            // Try to click "Newest first" option
            const newestOption = await headlessPage.evaluateHandle(() => {
              const options = Array.from(document.querySelectorAll('yt-formatted-string, button, a, div[role="menuitem"]'));
              return options.find(opt => {
                const text = (opt.textContent || '').toLowerCase();
                return text.includes('newest') || text.includes('recent') || text.includes('latest');
              });
            });
            
            if (newestOption && newestOption.asElement()) {
              await newestOption.asElement().click({ delay: 100 });
              await HumanEmulation.randomDelay(3000, 5000);
              console.log('✓ Sorted comments by newest first');
            }
          }
        } catch (sortError) {
          console.log('Could not sort comments, continuing with default order...');
        }
        
        // Scroll to comments section again
        await headlessPage.evaluate(() => {
          const commentsSection = document.querySelector('ytd-comments, #comments');
          if (commentsSection) {
            commentsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        });
        await HumanEmulation.randomDelay(3000, 5000);
        
        // Check if comment text is visible in page - try multiple times with scrolling
        // Focus on RECENT comments first (top of comments section)
        for (let attempt = 0; attempt < 5; attempt++) {
          commentVisible = await headlessPage.evaluate((text) => {
            const textToFind = text.substring(0, Math.min(50, text.length)); // Check first 50 chars
            
            // Strategy 1: Check RECENT comments first (top comments, sorted by newest)
            // YouTube shows recent comments at the top when sorted by "Newest first"
            const commentThreads = Array.from(document.querySelectorAll('ytd-comment-thread-renderer, ytd-comment-renderer'));
            
            // Check first 20 comments (most recent)
            for (const commentThread of commentThreads.slice(0, 20)) {
              // Get comment text from various possible locations
              const commentTextElements = commentThread.querySelectorAll(
                '#content-text, ytd-text-container, [id*="content-text"], span#content-text, ytd-comment-renderer #content-text'
              );
              
              for (const textEl of commentTextElements) {
                const commentText = (textEl.textContent || textEl.innerText || '').trim();
                if (commentText && (commentText.includes(text) || commentText.includes(textToFind))) {
                  // Verify this is actually a recent comment by checking timestamp
                  const timeElement = commentThread.querySelector('yt-formatted-string[class*="published-time"], a[class*="published-time"], #published-time-text');
                  if (timeElement) {
                    const timeText = (timeElement.textContent || '').toLowerCase();
                    // Recent comments typically show "X minutes ago", "X hours ago", "just now", or today's date
                    const isRecent = timeText.includes('minute') || 
                                   timeText.includes('hour') || 
                                   timeText.includes('just now') ||
                                   timeText.includes('second') ||
                                   timeText.includes('today') ||
                                   timeText.includes('ago');
                    
                    if (isRecent) {
                      console.log('Found comment in recent comments:', commentText.substring(0, 30));
                      return true;
                    }
                  } else {
                    // If no timestamp found, assume it's recent if it's in the top comments
                    console.log('Found comment (no timestamp, assuming recent):', commentText.substring(0, 30));
                    return true;
                  }
                }
              }
            }
            
            // Strategy 2: Check all comment elements (fallback)
            const commentElements = document.querySelectorAll('ytd-comment-thread-renderer, ytd-comment-renderer');
            for (const el of commentElements) {
              const elText = (el.textContent || el.innerText || '').trim();
              if (elText && (elText.includes(text) || elText.includes(textToFind))) {
                // Check if it's a recent comment
                const timeElement = el.querySelector('yt-formatted-string[class*="published-time"], a[class*="published-time"]');
                if (timeElement) {
                  const timeText = (timeElement.textContent || '').toLowerCase();
                  const isRecent = timeText.includes('minute') || 
                                 timeText.includes('hour') || 
                                 timeText.includes('just now') ||
                                 timeText.includes('second') ||
                                 timeText.includes('today');
                  if (isRecent) {
                    return true;
                  }
                }
              }
            }
            
            // Strategy 3: Check comment text spans specifically (last resort)
            const textSpans = document.querySelectorAll('span#content-text, ytd-text-container span, #content-text span');
            for (const span of textSpans.slice(0, 30)) { // Only check first 30 spans
              const spanText = (span.textContent || span.innerText || '').trim();
              if (spanText && (spanText.includes(text) || spanText.includes(textToFind))) {
                // Try to find parent comment thread to check timestamp
                const parentComment = span.closest('ytd-comment-thread-renderer, ytd-comment-renderer');
                if (parentComment) {
                  const timeElement = parentComment.querySelector('yt-formatted-string[class*="published-time"], a[class*="published-time"]');
                  if (timeElement) {
                    const timeText = (timeElement.textContent || '').toLowerCase();
                    const isRecent = timeText.includes('minute') || 
                                   timeText.includes('hour') || 
                                   timeText.includes('just now') ||
                                   timeText.includes('second') ||
                                   timeText.includes('today');
                    if (isRecent) {
                      return true;
                    }
                  } else {
                    // If in top 10 comments and no timestamp, assume recent
                    const allComments = Array.from(document.querySelectorAll('ytd-comment-thread-renderer, ytd-comment-renderer'));
                    const commentIndex = allComments.indexOf(parentComment);
                    if (commentIndex < 10) {
                      return true;
                    }
                  }
                }
              }
            }
            
            return false;
          }, commentText);
          
          if (commentVisible) {
            console.log(`✓ Comment found visible on attempt ${attempt + 1}`);
            break;
          }
          
          if (attempt < 4) {
            console.log(`Comment not found on attempt ${attempt + 1}, scrolling more and retrying...`);
            await headlessPage.evaluate(() => {
              window.scrollBy(0, window.innerHeight * 3);
            });
            await HumanEmulation.randomDelay(3000, 4000);
          }
        }
        
        await headlessBrowser.close();
        
        if (commentVisible) {
          console.log('✓ Comment verification: COMMENT IS VISIBLE (not shadowbanned)');
        } else {
          console.log('✗ Comment verification: COMMENT NOT VISIBLE (comment did not post or is shadowbanned)');
          verificationFailed = true;
        }
      } catch (headlessError) {
        console.error('Headless browser verification failed:', headlessError.message);
        verificationFailed = true;
        commentVisible = false;
        console.log('✗ Verification failed - treating as comment not visible (not posted or shadowbanned)');
      }
      
      // If verification failed, treat as shadowbanned
      if (verificationFailed) {
        commentVisible = false;
      }

      try {
        const log = new InteractionLog({
          profileId,
          action: 'shadowban_check',
          url: testVideoUrl,
          success: true,
          metadata: { shadowbanned: !commentVisible, commentText }
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save shadowban check log:', logError);
      }

      // If comment is not visible, it means either:
      // 1. Comment didn't post (shadowbanned or failed to post)
      // 2. Comment is pending moderation
      // 3. Comment was deleted
      if (!commentVisible) {
        console.log(`✗ Comment verification failed - comment not visible. Profile ${profileId} may be shadowbanned or comment failed to post.`);
        await Profile.updateStatus(profileId, 'ghosted');
      } else {
        console.log(`✓ Comment verification passed - comment is visible. Profile ${profileId} is not shadowbanned.`);
      }

      // Return true if shadowbanned (comment not visible), false if not shadowbanned (comment visible)
      return !commentVisible;
    } catch (error) {
      console.error('Shadowban check error:', error);
      
      // Check if error is due to banned channel
      const errorMessage = error.message?.toLowerCase() || '';
      const isBannedError = errorMessage.includes('banned') || 
                           errorMessage.includes('terminated') || 
                           errorMessage.includes('suspended') ||
                           errorMessage.includes('disabled');
      
      if (isBannedError) {
        console.log(`✗ YouTube channel appears to be banned based on error: ${error.message}`);
        const currentProfile = await Profile.findById(profileId);
        const currentNotes = currentProfile?.notes || '';
        const bannedNote = currentNotes.includes('Banned Youtube') 
          ? currentNotes 
          : currentNotes 
            ? `${currentNotes} | Banned Youtube`
            : 'Banned Youtube';
        await Profile.update(profileId, { notes: bannedNote });
        console.log(`✓ Updated profile ${profileId} notes with "Banned Youtube"`);
      }
      
      try {
        const log = new InteractionLog({
          profileId,
          action: 'shadowban_check',
          url: 'youtube.com',
          success: false,
          error: error.message,
          metadata: { isBannedError }
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save error log:', logError);
      }
      return false;
    }
  }
}
