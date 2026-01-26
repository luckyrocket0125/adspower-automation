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

          const updateResult = await Profile.updateTrustScore(profileId, score);
          console.log('✓ Profile.updateTrustScore called');
          console.log(`Update result:`, {
            matchedCount: updateResult.matchedCount,
            modifiedCount: updateResult.modifiedCount,
            acknowledged: updateResult.acknowledged
          });
          
          // Verify the update worked
          const updatedProfile = await Profile.findById(profileId);
          if (updatedProfile) {
            console.log(`✓ Verified trust score in database: ${updatedProfile.trustScore}`);
            if (updatedProfile.trustScore !== score) {
              console.error(`⚠ WARNING: Trust score mismatch! Expected: ${score}, Got: ${updatedProfile.trustScore}`);
            }
          } else {
            console.error(`✗ Could not find profile ${profileId} after update`);
          }
          
          try {
            const log = new InteractionLog({
              profileId,
              action: 'trust_score_check',
              url: 'https://antcpt.com/score_detector/',
              success: true,
              metadata: { score }
            });
            await log.save();
            console.log('✓ Interaction log saved');
          } catch (logError) {
            console.error('✗ Failed to save trust score log:', logError);
          }
        } catch (saveError) {
          console.error('✗ Error saving trust score:', saveError);
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

  async checkShadowban(page, profileId) {
    try {
      const testVideoUrl = 'https://www.youtube.com/watch?v=TtPXvEcE11E';
      await page.goto(testVideoUrl, { waitUntil: 'networkidle2' });
      await HumanEmulation.randomDelay(3000, 5000);

      const commentText = `Test comment ${Date.now()}`;
      
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
        }
      } catch (e) {
        console.log('No "Show comments" button found or already expanded');
      }
      
      // Wait for comments section to load
      try {
        await page.waitForSelector('ytd-comments, #comments, ytd-commentbox, ytd-comments-header-renderer', { timeout: 15000 });
        console.log('✓ Comments section loaded');
      } catch (e) {
        console.log('Comments section not found after waiting, checking if comments are disabled...');
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
                await HumanEmulation.randomDelay(5000, 7000);
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
          await HumanEmulation.randomDelay(3000, 5000);
        }
      } else {
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

      await HumanEmulation.randomDelay(10000, 15000);

      // Verify comment visibility using headless/incognito browser
      let commentVisible = false;
      try {
        const puppeteer = await import('puppeteer');
        const headlessBrowser = await puppeteer.launch({
          headless: true,
          args: ['--incognito', '--no-sandbox', '--disable-setuid-sandbox']
        });
        const headlessPage = await headlessBrowser.newPage();
        
        await headlessPage.goto(testVideoUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Scroll to comments section
        await headlessPage.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Check if comment text is visible in page
        commentVisible = await headlessPage.evaluate((text) => {
          const bodyText = document.body.textContent || '';
          return bodyText.includes(text);
        }, commentText);
        
        await headlessBrowser.close();
      } catch (headlessError) {
        console.log('Headless browser check failed, falling back to HTTP request:', headlessError.message);
        // Fallback to HTTP request if headless browser fails
        const response = await axios.get(testVideoUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        commentVisible = response.data.includes(commentText);
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
