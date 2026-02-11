import { AdsPowerService } from '../services/adspower.js';
import { Profile } from '../models/Profile.js';
import { InteractionLog } from '../models/InteractionLog.js';
import { getContentSuggestions } from '../services/openai.js';
import { HumanEmulation } from '../utils/humanEmulation.js';
import Parser from 'rss-parser';

export class Farmer {
  constructor() {
    this.adspower = new AdsPowerService();
    this.rssParser = new Parser();
  }

  async waitForNavigation(page, options = {}) {
    const timeout = options.timeout || 30000;
    const waitUntil = options.waitUntil || 'networkidle2';
    
    try {
      if (page.waitForLoadState) {
        await page.waitForLoadState(waitUntil === 'networkidle2' ? 'networkidle' : waitUntil, { timeout });
      } else {
        const currentUrl = page.url();
        await Promise.race([
          page.waitForNavigation({ waitUntil, timeout }),
          new Promise((resolve) => setTimeout(resolve, timeout))
        ]);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      if (error.message && (error.message.includes('timeout') || error.message.includes('Navigation') || error.message.includes('Target closed'))) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        throw error;
      }
    }
  }

  async handlePopupsAndModals(page, retries = 3) {
    if (page.isClosed()) return;
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await HumanEmulation.randomDelay(500, 1000);
        
        const popupHandled = await page.evaluate(() => {
        const handled = { found: false, action: '' };
        
        const findAndClick = (selectors, textPatterns = []) => {
          for (const selector of selectors) {
            try {
              const elements = Array.from(document.querySelectorAll(selector));
              for (const el of elements) {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                const isVisible = rect.width > 0 && rect.height > 0 && 
                                 style.display !== 'none' && 
                                 style.visibility !== 'hidden' &&
                                 style.opacity !== '0' &&
                                 el.offsetParent !== null;
                
                if (!isVisible) continue;
                
                const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
                const shouldClick = textPatterns.length === 0 || textPatterns.some(pattern => text.includes(pattern));
                
                if (shouldClick) {
                  el.click();
                  handled.found = true;
                  handled.action = `Clicked ${selector}`;
                  return true;
                }
              }
            } catch (e) {
              continue;
            }
          }
          return false;
        };
        
        // First, try to find and click DECLINE/REJECT cookie buttons (preferred)
        const declineCookieSelectors = [
          'button[id*="decline"]',
          'button[class*="decline"]',
          'button[id*="reject"]',
          'button[class*="reject"]',
          'button[id*="cookie"][id*="decline"]',
          'button[class*="cookie"][class*="decline"]',
          '[id*="cookie"] button[id*="decline"]',
          '[class*="cookie"] button[class*="decline"]',
          '[id*="consent"] button[id*="decline"]',
          '[class*="consent"] button[class*="decline"]',
          'button',
          'a[role="button"]',
          '[role="button"]'
        ];
        
        const declineCookieTexts = [
          'decline optional cookies',
          'decline cookies',
          'decline all',
          'decline',
          'reject all',
          'reject cookies',
          'reject',
          'reject optional',
          'necessary cookies only',
          'only necessary',
          'essential cookies only',
          'no thanks',
          'not now',
          'maybe later'
        ];
        
        // Try to find decline button in cookie consent popups
        const allButtons = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"]'));
        for (const btn of allButtons) {
          const rect = btn.getBoundingClientRect();
          const style = window.getComputedStyle(btn);
          const isVisible = rect.width > 0 && rect.height > 0 && 
                           style.display !== 'none' && 
                           style.visibility !== 'hidden' &&
                           style.opacity !== '0' &&
                           btn.offsetParent !== null;
          
          if (!isVisible) continue;
          
          const text = (btn.textContent || btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase().trim();
          
          // Check if this button is in a cookie consent popup
          const parent = btn.closest('[id*="cookie"], [class*="cookie"], [id*="consent"], [class*="consent"], [id*="gdpr"], [class*="gdpr"], [role="dialog"]');
          if (parent) {
            // Check if button text matches decline patterns
            if (declineCookieTexts.some(pattern => text.includes(pattern))) {
              btn.click();
              handled.found = true;
              handled.action = 'Declined cookie consent';
              return handled;
            }
          }
        }
        
        // If no decline button found, try to find ACCEPT cookie buttons
        const cookieConsentSelectors = [
          'button[id*="cookie"]',
          'button[class*="cookie"]',
          'button[id*="accept"]',
          'button[class*="accept"]',
          'button[id*="consent"]',
          'button[class*="consent"]',
          'button[id*="gdpr"]',
          'button[class*="gdpr"]',
          '[id*="cookie"] button',
          '[class*="cookie"] button',
          '[id*="consent"] button',
          '[class*="consent"] button',
          '[id*="gdpr"] button',
          '[class*="gdpr"] button',
          '[data-testid*="cookie"] button',
          '[data-testid*="consent"] button'
        ];
        
        const cookieConsentTexts = [
          'accept', 'agree', 'allow', 'ok', 'got it', 'continue', 'consent', 'cookie', 'gdpr',
          'i accept', 'accept all', 'accept cookies', 'allow cookies', 'accept all cookies'
        ];
        
        if (findAndClick(cookieConsentSelectors, cookieConsentTexts)) {
          handled.action = 'Accepted cookie consent';
          return handled;
        }
        
        const emailNewsletterSelectors = [
          'button[aria-label*="close"]',
          'button[aria-label*="Close"]',
          'button[class*="close"]',
          'button[class*="dismiss"]',
          'button[id*="close"]',
          'button[id*="dismiss"]',
          '[class*="newsletter"] button[class*="close"]',
          '[class*="email"] button[class*="close"]',
          '[id*="newsletter"] button',
          '[id*="email"] button',
          '[class*="popup"] button[class*="close"]',
          '[class*="modal"] button[class*="close"]',
          '[role="dialog"] button[aria-label*="close"]',
          '[role="dialog"] button[aria-label*="Close"]',
          'button:has-text("Close")',
          'button:has-text("No thanks")',
          'button:has-text("Not now")',
          'button:has-text("Maybe later")',
          'button:has-text("Skip")',
          '[data-dismiss="modal"]',
          '[data-close="modal"]'
        ];
        
        const emailNewsletterTexts = [
          'close', 'dismiss', 'no thanks', 'not now', 'maybe later', 'skip', 'later',
          'no thank you', 'decline', 'not interested'
        ];
        
        if (findAndClick(emailNewsletterSelectors, emailNewsletterTexts)) {
          handled.action = 'Email/newsletter popup';
          return handled;
        }
        
        const generalModalSelectors = [
          '[role="dialog"] button[aria-label*="close"]',
          '[role="dialog"] button[aria-label*="Close"]',
          '.modal button[class*="close"]',
          '.modal button[aria-label*="close"]',
          '.popup button[class*="close"]',
          '.popup button[aria-label*="close"]',
          '[class*="overlay"] button[class*="close"]',
          '[class*="backdrop"] button[class*="close"]',
          'button[data-dismiss="modal"]',
          'button[data-close="modal"]',
          'button[aria-label="Close"]',
          'button[aria-label="close"]',
          'button[title="Close"]',
          'button[title="close"]'
        ];
        
        if (findAndClick(generalModalSelectors)) {
          handled.action = 'General modal';
          return handled;
        }
        
        return handled;
        });
        
        if (popupHandled.found) {
          console.log(`✓ Handled popup: ${popupHandled.action} (attempt ${attempt + 1}/${retries})`);
          await HumanEmulation.randomDelay(1000, 2000);
          
          // Check if popup is still open
          const stillOpen = await page.evaluate(() => {
            // Check for visible dialogs/modals/popups
            const dialogs = document.querySelectorAll('[role="dialog"], .modal, .popup, [class*="overlay"], [class*="backdrop"], [id*="cookie"], [class*="cookie"], [id*="consent"], [class*="consent"]');
            for (const dialog of dialogs) {
              const style = window.getComputedStyle(dialog);
              const rect = dialog.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && 
                  style.display !== 'none' && 
                  style.visibility !== 'hidden' && 
                  style.opacity !== '0' &&
                  style.zIndex && parseInt(style.zIndex) > 100) {
                return true;
              }
            }
            return false;
          });
          
          if (!stillOpen) {
            // Popup was successfully closed
            return;
          } else if (attempt < retries - 1) {
            // Popup still open, try again
            console.log(`Popup still open, retrying... (attempt ${attempt + 2}/${retries})`);
            await page.keyboard.press('Escape');
            await HumanEmulation.randomDelay(500, 1000);
            continue;
          } else {
            // Last attempt, try Escape key
            console.log('Popup still open after all attempts, trying Escape key...');
            await page.keyboard.press('Escape');
            await HumanEmulation.randomDelay(500, 1000);
          }
        } else {
          // No popup found, check if we should retry
          if (attempt === 0) {
            // On first attempt, wait a bit longer for popups to appear
            await HumanEmulation.randomDelay(1000, 1500);
            continue;
          } else {
            // No popup found after waiting, exit
            return;
          }
        }
      } catch (error) {
        console.log(`Popup handling error (attempt ${attempt + 1}/${retries}): ${error.message}`);
        if (attempt < retries - 1) {
          await HumanEmulation.randomDelay(1000, 2000);
          continue;
        }
      }
    }
  }

  async farmProfile(profileId, options = {}) {
    const profile = await Profile.findById(profileId);
    if (!profile) {
      throw new Error(`Profile ${profileId} not found`);
    }

    if (profile.networkError) {
      console.log(`Profile ${profileId} has network error, skipping`);
      return;
    }

    let browser;
    let page;

    try {
      // Navigate directly to Google instead of showing start.adspower.net
      const openTabs = options.runHidden === false ? 1 : 0;
      browser = await this.adspower.connectBrowser(profileId, { initialUrl: 'https://www.google.com', openTabs });
      
      // Ensure start.adspower.net page is closed (extra safety check)
      try {
        const pages = await browser.pages();
        for (const p of pages) {
          try {
            const url = p.url();
            if (url.includes('start.adspower.net')) {
              console.log('Closing start.adspower.net page (farming safety check)...');
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
      
      try {
        const pages = await browser.pages();
        page = pages[0];
        if (!page) {
          console.log('No existing pages found, creating new page...');
          page = await Promise.race([
            browser.newPage(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Page creation timeout')), 60000)
            )
          ]);
        }
      } catch (pageError) {
        console.error('Error getting/creating page:', pageError.message);
        throw pageError;
      }

      const contentSuggestions = await getContentSuggestions(profile.persona);

      await this.browseGoogleSearch(page, profileId, contentSuggestions.searchQueries);
      
      // Re-fetch profile to get latest notes (in case they were updated by DNA analysis)
      const latestProfile = await Profile.findById(profileId);
      const notes = (latestProfile?.notes || '').toLowerCase();
      const hasNoAccount = notes.includes('no youtube account');
      const isBanned = notes.includes('banned youtube');
      
      // Skip YouTube farming if account doesn't exist or is banned
      if (!hasNoAccount && !isBanned) {
        await this.farmYouTube(page, profileId, contentSuggestions.searchQueries);
      } else {
        if (hasNoAccount) {
          console.log(`⚠ Skipping YouTube farming - account does not exist (from DNA analysis)`);
        }
        if (isBanned) {
          console.log(`⚠ Skipping YouTube farming - account is banned`);
        }
      }
      
      await this.useGoogleDrive(page, profileId, browser);
      await this.useGoogleSheets(page, profileId, browser);
      await this.useGoogleDocs(page, profileId, browser);
      await this.useGoogleNews(page, profileId);
      await this.useGoogleMaps(page, profileId, profile.proxy);
      if (contentSuggestions && contentSuggestions.searchQueries && contentSuggestions.searchQueries.length > 0) {
        await this.useGemini(page, profileId, contentSuggestions.searchQueries);
      } else {
        console.log('⚠ No search queries available for Gemini, skipping');
      }

      await Profile.update(profileId, { lastFarmed: new Date() });
      try {
        const log = new InteractionLog({
          profileId,
          action: 'farming_complete',
          url: 'multiple',
          success: true
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save farming log:', logError);
      }

    } catch (error) {
      console.error(`Farming error for profile ${profileId}:`, error);
      
      if (error.message.includes('timeout') || error.message.includes('network')) {
        await Profile.flagNetworkError(profileId, true);
      }

      try {
        const log = new InteractionLog({
          profileId,
          action: 'farming_complete',
          url: 'multiple',
          success: false,
          error: error.message
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save error log:', logError);
      }

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

  async browseGoogleSearch(page, profileId, searchQueries) {
    if (!searchQueries || searchQueries.length === 0) {
      console.log('No search queries provided, skipping Google Search browsing');
      return;
    }

    const queriesToUse = searchQueries.slice(0, 2);
    let successfulSearches = 0;

    for (const query of queriesToUse) {
      if (page.isClosed()) {
        console.log('Page closed, skipping remaining searches');
        break;
      }

      try {
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
          console.log(`Invalid search query: ${query}, skipping`);
          continue;
        }

        console.log(`Searching Google for: "${query}"`);
        
        await page.goto('https://www.google.com/?hl=en&gl=US', { waitUntil: 'networkidle2', timeout: 30000 });
        await HumanEmulation.randomDelay(2000, 4000);
        
              if (page.isClosed()) {
          console.log('Page closed after navigation to Google');
                break;
              }
              
        await HumanEmulation.simulateReading(page, 2000);
        
        const searchBoxSelectors = [
          'textarea[name="q"]',
          'input[name="q"]',
          'textarea[aria-label*="Search"]',
          'input[aria-label*="Search"]',
          'textarea[type="search"]',
          'input[type="search"]'
        ];
        
        let searchSelector = null;
        for (const selector of searchBoxSelectors) {
          try {
            await page.waitForSelector(selector, { timeout: 5000, visible: true });
            const searchBox = await page.$(selector);
            if (searchBox) {
              const isVisible = await searchBox.evaluate(el => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && 
                       style.display !== 'none' && 
                       style.visibility !== 'hidden' &&
                       el.offsetParent !== null;
              });
              if (isVisible) {
                searchSelector = selector;
                console.log(`✓ Found search box using selector: ${selector}`);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        if (!searchSelector) {
          console.log('⚠ Search box not found, skipping this query');
          continue;
        }
        
        await HumanEmulation.humanType(page, searchSelector, query);
        await HumanEmulation.randomDelay(1000, 2000);
        
        await page.keyboard.press('Enter');
        await this.waitForNavigation(page, { waitUntil: 'networkidle2', timeout: 30000 });
        await HumanEmulation.randomDelay(1000, 2000);
              
        if (page.isClosed()) {
          console.log('Page closed after search');
          break;
        }
        
        const searchResults = await page.evaluate(() => {
          const results = [];
          const links = document.querySelectorAll('a[href*="/url?q="], a[href^="http"]');
          
          for (const link of links) {
            const href = link.getAttribute('href');
            if (!href) continue;
            
            let url = href;
            if (href.startsWith('/url?q=')) {
              const match = href.match(/\/url\?q=([^&]+)/);
              if (match) url = decodeURIComponent(match[1]);
            }
            
            if (url.startsWith('http') && 
                !url.includes('google.com') && 
                !url.includes('youtube.com/watch') &&
                !url.includes('accounts.google.com')) {
              const text = link.textContent?.trim() || '';
              if (text.length > 0) {
                results.push({ url, text });
              }
            }
            
            if (results.length >= 2) break;
          }
          
          return results;
        });
        
        if (searchResults.length === 0) {
          console.log('No search results found, skipping');
          continue;
        }
        
        console.log(`Found ${searchResults.length} search result(s), selecting top result(s)`);
        
        for (const result of searchResults.slice(0, 1)) {
          if (page.isClosed()) {
            console.log('Page closed, skipping remaining results');
            break;
          }
          
          // Store the current URL (Google search results page) before clicking
          let googleSearchUrl = null;
          try {
            googleSearchUrl = page.url();
          } catch {}
          
          try {
            console.log(`Clicking on search result: ${result.text.substring(0, 50)}...`);
            
            const clicked = await page.evaluate((url) => {
              const links = Array.from(document.querySelectorAll('a[href]'));
              const targetDomain = url.split('/')[2]?.toLowerCase();
              
              for (const link of links) {
                let href = link.getAttribute('href');
                if (!href) continue;
                
                // Handle Google search result URLs
                if (href.startsWith('/url?q=')) {
                  const match = href.match(/\/url\?q=([^&]+)/);
                  if (match) {
                    try {
                      href = decodeURIComponent(match[1]);
                    } catch (e) {
                      continue;
                    }
                  }
                }
                
                // Normalize URLs for comparison
                try {
                  const linkUrl = new URL(href, window.location.href);
                  const resultUrl = new URL(url);
                  
                  // Check if domains match
                  if (linkUrl.hostname.toLowerCase() === resultUrl.hostname.toLowerCase()) {
                    // Check if paths are similar (handle URL fragments and query params)
                    const linkPath = linkUrl.pathname.toLowerCase();
                    const resultPath = resultUrl.pathname.toLowerCase();
                    if (linkPath === resultPath || linkPath.includes(resultPath.split('/').pop()) || resultPath.includes(linkPath.split('/').pop())) {
                      link.click();
                      return true;
                    }
                  }
                  
                  // Fallback: check if href contains the target domain
                  if (targetDomain && linkUrl.hostname.toLowerCase().includes(targetDomain)) {
                    link.click();
                      return true;
                  }
                } catch (e) {
                  // If URL parsing fails, try simple string matching
                  if (href.includes(targetDomain) || href === url) {
                    link.click();
                      return true;
                  }
                }
              }
              return false;
            }, result.url);
            
            if (!clicked) {
              console.log(`Could not find link for ${result.url}, trying direct navigation`);
              await page.goto(result.url, { waitUntil: 'networkidle2', timeout: 30000 });
            } else {
              await this.waitForNavigation(page, { waitUntil: 'networkidle2', timeout: 30000 });
            }
            
            // Wait for page to fully load, then handle popups with retries
            await HumanEmulation.randomDelay(1500, 2500);
            await this.handlePopupsAndModals(page, 3);
            
            // Wait again after handling popups to ensure page is stable
            await HumanEmulation.randomDelay(1000, 2000);
            
            // Check if page is in English, if not, translate or skip
            if (!page.isClosed()) {
              const pageLanguage = await page.evaluate(() => {
                // Check HTML lang attribute
                const htmlLang = document.documentElement.getAttribute('lang');
                if (htmlLang && htmlLang.toLowerCase().startsWith('en')) {
                  return 'en';
                }
                
                // Check meta language tag
                const metaLang = document.querySelector('meta[http-equiv="content-language"]');
                if (metaLang && metaLang.getAttribute('content')?.toLowerCase().startsWith('en')) {
                  return 'en';
                }
                
                // Sample text from page to detect language (simple heuristic)
                const bodyText = document.body?.textContent?.substring(0, 500) || '';
                const commonEnglishWords = ['the', 'and', 'is', 'are', 'was', 'were', 'this', 'that', 'with', 'from'];
                const englishWordCount = commonEnglishWords.filter(word => 
                  bodyText.toLowerCase().includes(' ' + word + ' ')
                ).length;
                
                // If we find many English words, likely English
                if (englishWordCount >= 3) {
                  return 'en';
                }
                
                // Check if lang attribute exists but is not English
                if (htmlLang && !htmlLang.toLowerCase().startsWith('en')) {
                  return htmlLang.split('-')[0];
                }
                
                return 'unknown';
              });
              
              if (pageLanguage !== 'en' && pageLanguage !== 'unknown') {
                console.log(`⚠ Page is in ${pageLanguage}, attempting to translate to English...`);
                
                // Try to use Google Translate
                const currentUrl = page.url();
                const translatedUrl = `https://translate.google.com/translate?sl=auto&tl=en&u=${encodeURIComponent(currentUrl)}`;
                
                try {
                  await page.goto(translatedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                  await HumanEmulation.randomDelay(3000, 5000);
                  console.log('✓ Page translated to English');
                } catch (translateError) {
                  console.log(`⚠ Could not translate page, skipping this result: ${translateError.message}`);
                  // Return to Google search and skip this result
                  if (googleSearchUrl) {
                    await page.goto(googleSearchUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                  }
                  continue;
                }
              }
            }
            
              if (!page.isClosed()) {
              await HumanEmulation.simulateReading(page, 2000 + Math.random() * 2000);
              
              // Click internal links (70% chance - important for realistic browsing)
              if (Math.random() < 0.7) {
                await this.clickInternalLinks(page, profileId);
              }
              
              // Copy text of interest (15% chance, reduced from 30%)
              if (Math.random() < 0.15) {
                await this.copyTextOfInterest(page, profileId);
              }
              
              // Rarely bookmark (2% chance, reduced from 5%)
              if (Math.random() < 0.02) {
                await this.bookmarkPage(page, profileId);
              }
            }

            try {
              const log = new InteractionLog({
                profileId,
                action: 'google_search_browse',
                url: result.url,
                metadata: { query, resultTitle: result.text },
                success: true
              });
              await log.save();
            } catch (logError) {
              console.error('Failed to save search log:', logError);
            }
            
            await HumanEmulation.randomDelay(2000, 4000);
            
            if (!page.isClosed()) {
              await page.goBack({ waitUntil: 'networkidle2', timeout: 30000 });
              await HumanEmulation.randomDelay(2000, 3000);
            }
          } catch (navError) {
            if (navError.message.includes('detached') || navError.message.includes('closed')) {
              console.log('Page detached/closed during navigation, skipping');
              break;
            }
            console.log(`Failed to navigate to ${result.url}: ${navError.message}`);
            
            // Return to original Google search results page on failure
            if (!page.isClosed()) {
              try {
                const currentUrl = page.url();
                // If we're not on Google search page, go back or navigate to it
                if (!currentUrl.includes('google.com/search') && googleSearchUrl) {
                  console.log('Returning to Google search results page...');
                  await page.goto(googleSearchUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(async () => {
                    // If goto fails, try goBack
                    await page.goBack({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                  });
                  await HumanEmulation.randomDelay(2000, 3000);
                } else {
                  // Try goBack as fallback
                  await page.goBack({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                  await HumanEmulation.randomDelay(2000, 3000);
                }
                console.log('✓ Returned to Google search results page');
              } catch (backError) {
                console.log('⚠ Could not return to Google search page:', backError.message);
                // Last resort: navigate to Google search with the query
                try {
                  await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=US`, { waitUntil: 'networkidle2', timeout: 30000 });
                  await HumanEmulation.randomDelay(2000, 3000);
                } catch (finalError) {
                  console.log('⚠ Could not recover Google search page');
                }
              }
            }
            continue;
          }
        }
        
        successfulSearches++;
      } catch (error) {
        console.log(`Google Search error for query "${query}": ${error.message || error} - skipping`);
        continue;
      }
    }

    if (successfulSearches === 0 && queriesToUse.length > 0) {
      console.log('⚠ All Google searches failed, but continuing with other farming activities');
    } else if (successfulSearches > 0) {
      console.log(`✓ Successfully performed ${successfulSearches} Google search(es)`);
    }
  }

  async useGoogleDrive(page, profileId, browser = null) {
    console.log('🚀 Starting Google Drive farming...');
    try {
      // Check if page is still valid
      if (page.isClosed()) {
        console.log('Page closed, skipping Google Drive');
        return;
      }
      
      console.log('Navigating to Google Drive...');
      await page.goto('https://drive.google.com/?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
      
      // Check again after navigation
      if (page.isClosed()) {
        console.log('Page closed after navigation to Google Drive');
        return;
      }
      
      await this.handlePopupsAndModals(page);
      await HumanEmulation.randomDelay(2000, 4000);

      // Check for and close tutorial modal if present
      try {
        const tutorialCloseSelectors = [
          'button[aria-label*="Close"]',
          'button[aria-label*="Cerrar"]',
          'button[aria-label*="Close tutorial"]',
          '[role="dialog"] button[aria-label*="Close"]',
          '[role="dialog"] button[aria-label*="Cerrar"]',
          'button:has-text("Close")',
          'button:has-text("Cerrar")',
          '[data-dismiss="modal"]',
          '.modal button[aria-label*="Close"]'
        ];
        
        // Try to find and close tutorial modal
        for (const selector of tutorialCloseSelectors) {
          try {
            const closeButton = await page.$(selector);
            if (closeButton) {
              const isVisible = await page.evaluate((el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
              }, closeButton);
              
              if (isVisible) {
                console.log('Found tutorial modal, closing it...');
                await closeButton.click();
                await HumanEmulation.randomDelay(1000, 2000);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        // Also try pressing Escape key to close modal
        await page.keyboard.press('Escape');
        await HumanEmulation.randomDelay(500, 1000);
      } catch (modalError) {
        console.log('No tutorial modal found or already closed');
      }

      // Check before each operation
      if (page.isClosed()) {
        console.log('Page closed during Google Drive operation');
        return;
      }

      // Find the "New" button - based on actual Google Drive HTML structure
      // The button has: aria-label="New", data-tooltip="New", guidedhelpid="new_menu_button"
      // Important: Must check aria-disabled="false" to ensure it's enabled
      const newButtonSelectors = [
        'button[aria-label="New"][aria-disabled="false"]',
        'button[data-tooltip="New"][aria-disabled="false"]',
        'button[guidedhelpid="new_menu_button"][aria-disabled="false"]',
        'button[aria-label*="New" i][aria-disabled="false"]',
        'button[aria-label*="Nuevo" i][aria-disabled="false"]',
        'button[data-tooltip*="New" i][aria-disabled="false"]',
        'button[data-tooltip*="Nuevo" i][aria-disabled="false"]',
        'button[aria-label*="Create" i][aria-disabled="false"]',
        'button[aria-label*="Crear" i][aria-disabled="false"]'
      ];
      
      let newButton = null;
      let newButtonSelector = null;
      
      // Strategy 1: Wait for enabled "New" button
      for (const selector of newButtonSelectors) {
        try {
          console.log(`Trying New button selector: ${selector}`);
          await page.waitForSelector(selector, { timeout: 5000, visible: true });
          newButton = await page.$(selector);
          if (newButton) {
            const isEnabled = await newButton.evaluate(el => {
              const ariaDisabled = el.getAttribute('aria-disabled');
              const hasDisabledClass = el.classList.contains('RDPZE'); // Google's disabled class
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return ariaDisabled !== 'true' && 
                     !hasDisabledClass &&
                     style.display !== 'none' && 
                     style.visibility !== 'hidden' &&
                     style.opacity !== '0' &&
                     rect.width > 0 && 
                     rect.height > 0;
            });
            if (isEnabled) {
              newButtonSelector = selector;
              console.log(`✓ Found enabled New button using selector: ${selector}`);
              break;
            } else {
              console.log(`Button found but disabled: ${selector}`);
              newButton = null;
            }
          }
        } catch (e) {
          console.log(`Selector failed: ${selector}`);
          continue;
        }
      }
      
      // Strategy 2: Find by evaluating page if selectors fail
      if (!newButton) {
        console.log('New button not found by selectors, trying evaluate method...');
        const foundButton = await page.evaluateHandle(() => {
          const buttons = Array.from(document.querySelectorAll('button[aria-label*="New" i], button[data-tooltip*="New" i]'));
          return buttons.find(btn => {
            const ariaDisabled = btn.getAttribute('aria-disabled');
            const hasDisabledClass = btn.classList.contains('RDPZE');
            const guidedHelpId = btn.getAttribute('guidedhelpid');
            const isNewButton = (guidedHelpId === 'new_menu_button' || 
                                guidedHelpId === 'td_new_menu_button') &&
                               ariaDisabled !== 'true' &&
                               !hasDisabledClass;
            
            if (isNewButton) {
              const rect = btn.getBoundingClientRect();
              const style = window.getComputedStyle(btn);
              return rect.width > 0 && rect.height > 0 &&
                     style.display !== 'none' &&
                     style.visibility !== 'hidden';
            }
            return false;
          });
        });
        
        if (foundButton && foundButton.asElement()) {
          newButton = foundButton.asElement();
          console.log('✓ Found New button using evaluate method');
        }
      }
      
      if (newButton) {
        try {
          // Check if button is visible and clickable
          const isVisible = await page.evaluate((el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          }, newButton);
          
          if (!isVisible) {
            console.log('New button found but not visible, skipping');
            return;
          }
          
          await HumanEmulation.moveMouse(page, 100, 100, 200, 200);
          
          // Use the element handle directly instead of re-querying
          await newButton.scrollIntoView();
          await HumanEmulation.randomDelay(200, 500);
          await newButton.click();
          console.log('✓ Clicked New button, waiting for menu to appear...');
          await HumanEmulation.randomDelay(500, 1000);
        } catch (clickError) {
          if (clickError.message.includes('detached') || clickError.message.includes('not clickable') || clickError.message.includes('not an Element')) {
            console.log('Button not clickable or detached, skipping Google Drive creation');
            return;
          }
          throw clickError;
        }

        // Check page state before looking for menu
        if (page.isClosed()) {
          console.log('Page closed during Google Drive button click');
          return;
        }

        // Wait for the context menu to appear after clicking "New"
        console.log('Waiting for New menu to appear...');
        try {
          await page.waitForSelector('[role="menu"], [role="listbox"], .goog-menu, [jsaction*="menu"]', { 
            timeout: 5000, 
            visible: true 
          });
          console.log('✓ Menu appeared');
        } catch (menuWaitError) {
          console.log('Menu did not appear, trying to find Google Docs anyway...');
        }

        // Find Google Docs option in the menu - multiple strategies
        let docOption = null;
        
        // Strategy 2: Use evaluate to find by text content
        const foundDocOption = await page.evaluateHandle(() => {
          // Find all menu items
          const menuItems = Array.from(document.querySelectorAll(
            '[role="menuitem"], .goog-menuitem, li[role="menuitem"], div[role="menuitem"]'
          ));
          
          // Look for Google Docs specifically
          const docsItem = menuItems.find(item => {
            const text = (item.textContent || '').toLowerCase().trim();
            const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();
            const title = (item.getAttribute('title') || '').toLowerCase();
            
            // Check for Google Docs indicators
            const hasDocs = (text.includes('google docs') || 
                           text.includes('docs') ||
                           ariaLabel.includes('docs') ||
                           title.includes('docs')) &&
                           !text.includes('sheets') &&
                           !text.includes('slides') &&
                           !text.includes('forms') &&
                   !text.includes('folder') && 
                           !text.includes('upload');
            
            if (hasDocs) {
              // Verify it's visible and clickable
              const rect = item.getBoundingClientRect();
              const style = window.getComputedStyle(item);
              return rect.width > 0 && 
                     rect.height > 0 &&
                     style.display !== 'none' &&
                     style.visibility !== 'hidden' &&
                     style.opacity !== '0';
            }
            return false;
          });
          
          return docsItem || null;
        });
        
        if (foundDocOption && foundDocOption.asElement()) {
          docOption = foundDocOption.asElement();
          console.log('✓ Found Google Docs option in menu');
        } else {
          // Strategy 3: Try finding by icon or specific attributes
          console.log('Google Docs not found by text, trying alternative methods...');
          const altDocOption = await page.evaluateHandle(() => {
            // Look for menu items that might be Google Docs based on structure
            const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
            // Google Docs is typically the 4th item (after New folder, File upload, Folder upload)
            if (menuItems.length >= 4) {
              const potentialDocs = menuItems[3]; // 0-indexed, so 3 = 4th item
              const rect = potentialDocs.getBoundingClientRect();
              const style = window.getComputedStyle(potentialDocs);
              if (rect.width > 0 && rect.height > 0 &&
                  style.display !== 'none' &&
                  style.visibility !== 'hidden') {
                return potentialDocs;
              }
            }
            return null;
          });
          
          if (altDocOption && altDocOption.asElement()) {
            docOption = altDocOption.asElement();
            console.log('✓ Found potential Google Docs option (by position)');
          }
        }
        
        if (docOption) {
          // Get browser instance to detect new tabs
          const browserInstance = browser || page.browser();
          const originalPages = await browserInstance.pages();
          const originalPageCount = originalPages.length;
          
          try {
            await docOption.scrollIntoView();
            await HumanEmulation.randomDelay(300, 600);
            
            // Try clicking with multiple methods
            try {
              await docOption.click();
            } catch (clickErr) {
              // Fallback: use evaluate to click
              await page.evaluate(el => el.click(), docOption);
            }
            
            console.log('✓ Clicked Google Docs option, waiting for new tab...');
            await HumanEmulation.randomDelay(2000, 3000);
          } catch (docClickError) {
            if (docClickError.message.includes('detached') || docClickError.message.includes('not clickable')) {
              console.log('Document option not clickable, skipping');
              return;
            }
            throw docClickError;
          }

          // Wait for new tab/page to open (Google Docs opens in new tab)
          let docsPage = null;
          const maxWaitTime = 30000; // 30 seconds - give more time
          const startTime = Date.now();
          
          console.log('Detecting new tab for Google Docs...');
          console.log(`Initial page count: ${originalPageCount}`);
          
          // Set up a promise to detect new page via event listener
          const newPagePromise = new Promise((resolve) => {
            const timeout = setTimeout(() => {
              browserInstance.removeListener('targetcreated', onTargetCreated);
              resolve(null);
            }, maxWaitTime);
            
            const onTargetCreated = async (target) => {
              try {
                const newPage = await target.page();
                if (newPage) {
                  console.log(`✓ New target created, URL: ${newPage.url()}`);
                  clearTimeout(timeout);
                  browserInstance.removeListener('targetcreated', onTargetCreated);
                  resolve(newPage);
                }
              } catch (e) {
                console.log('Error getting page from target:', e.message);
              }
            };
            
            browserInstance.on('targetcreated', onTargetCreated);
          });
          
          // Also poll for new pages
          let foundNewPage = null;
          while (Date.now() - startTime < maxWaitTime && !foundNewPage) {
            const currentPages = await browserInstance.pages();
            console.log(`Current page count: ${currentPages.length}`);
            
            // Check if a new page was created
            if (currentPages.length > originalPageCount) {
              // Find the new page (usually the last one)
              const newPages = currentPages.slice(originalPageCount);
              for (const newPage of newPages) {
                try {
                  const url = newPage.url();
                  console.log(`Found new page with URL: ${url}`);
                  
                  // Accept any new page (even about:blank) - it will navigate to Google Docs
                  if (url === 'about:blank' || url.includes('docs.google.com') || url.includes('document') || url.includes('google.com')) {
                    foundNewPage = newPage;
                    console.log(`✓ Found new tab: ${url}`);
                    break;
                  }
                } catch (urlError) {
                  console.log('Error getting URL from new page:', urlError.message);
                }
              }
            }
            
            // Also check if current page navigated to Google Docs
            if (!foundNewPage && !page.isClosed()) {
              try {
                const currentUrl = page.url();
                if (currentUrl.includes('docs.google.com') || currentUrl.includes('document')) {
                  foundNewPage = page;
                  console.log(`✓ Current page navigated to Google Docs: ${currentUrl}`);
                  break;
                }
              } catch (urlError) {
                // Page might be navigating
              }
            }
            
            if (!foundNewPage) {
              await HumanEmulation.randomDelay(500, 1000);
            }
          }
          
          // Use the found page or wait for event-based detection
          if (foundNewPage) {
            docsPage = foundNewPage;
          } else {
            // Try event-based detection
            const eventPage = await newPagePromise;
            if (eventPage) {
              docsPage = eventPage;
            }
          }
          
          if (!docsPage) {
            console.log('⚠ New Google Docs tab not detected, checking all pages...');
            // Last resort: check all pages for Google Docs URL
            const allPages = await browserInstance.pages();
            for (const checkPage of allPages) {
              try {
                const url = checkPage.url();
                if (url.includes('docs.google.com') || url.includes('/document/')) {
                  docsPage = checkPage;
                  console.log(`✓ Found Google Docs in existing page: ${url}`);
                  break;
                }
              } catch (e) {
                continue;
              }
            }
          }
          
          if (!docsPage) {
            console.log('⚠ Still no Google Docs tab found, using current page as fallback...');
            docsPage = page;
          }
          
          // Wait for the new tab to navigate to Google Docs URL
          console.log(`Waiting for Google Docs page to navigate... Current URL: ${docsPage.url()}`);
          
          // If it's about:blank or not docs.google.com, wait for navigation
          const currentUrl = docsPage.url();
          if (currentUrl === 'about:blank' || !currentUrl.includes('docs.google.com')) {
            console.log('Waiting for navigation to docs.google.com...');
            try {
              await Promise.race([
                this.waitForNavigation(docsPage, { waitUntil: 'networkidle2', timeout: 20000 }),
                new Promise((resolve) => {
                  // Also check URL periodically
                  const checkInterval = setInterval(async () => {
                    try {
                      const url = docsPage.url();
                      if (url.includes('docs.google.com')) {
                        clearInterval(checkInterval);
                        resolve();
                      }
                    } catch (e) {
                      clearInterval(checkInterval);
                      resolve();
                    }
                  }, 1000);
                  
                  setTimeout(() => {
                    clearInterval(checkInterval);
                    resolve();
                  }, 20000);
                })
              ]);
              console.log(`✓ Navigated to: ${docsPage.url()}`);
            } catch (navError) {
              console.log('Navigation wait timeout, but continuing...');
            }
          }
          
          // Additional wait for page to fully load
          console.log(`Final URL: ${docsPage.url()}`);
          await HumanEmulation.randomDelay(3000, 5000);
          
          // Wait for page to be ready
          try {
            await docsPage.waitForFunction(
              () => document.readyState === 'complete',
              { timeout: 10000 }
            );
            console.log('✓ Page is ready');
          } catch (readyError) {
            console.log('Page ready check timeout, but continuing...');
          }
          
          // Wait for Google Docs editor to load - try multiple selectors
          console.log('Waiting for Google Docs editor to load...');
          const editorSelectors = [
            '[contenteditable="true"]',
            '.kix-appview-editor',
            '.kix-page-content-wrapper',
            '.kix-page',
            '.kix-page-content',
            '#kix-app',
            '[role="textbox"]',
            '.kix-edit-mode',
            'div[contenteditable="true"]',
            '[aria-label*="document" i]',
            '[aria-label*="editor" i]'
          ];
          
          let editorFound = false;
          let editor = null;
          
          // Strategy 1: Wait for any editor selector
          for (const selector of editorSelectors) {
            try {
              console.log(`Trying editor selector: ${selector}`);
              await docsPage.waitForSelector(selector, { timeout: 5000, visible: true });
              editor = await docsPage.$(selector);
          if (editor) {
                const isVisible = await editor.evaluate(el => {
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && 
                         rect.height > 0 &&
                         style.display !== 'none' &&
                         style.visibility !== 'hidden' &&
                         style.opacity !== '0';
                });
                if (isVisible) {
                  console.log(`✓ Found editor with selector: ${selector}`);
                  editorFound = true;
                  break;
                }
              }
            } catch (e) {
              console.log(`Selector ${selector} not found yet`);
              continue;
            }
          }
          
          // Strategy 2: Use page evaluation to find editor
          if (!editorFound) {
            console.log('Editor not found by selectors, trying page evaluation...');
            const foundEditor = await docsPage.evaluateHandle(() => {
              // Try multiple methods to find the editor
              const methods = [
                // Method 1: contenteditable elements
                () => {
                  const contenteditables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
                  return contenteditables.find(el => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 100 && rect.height > 100 &&
                           style.display !== 'none' &&
                           style.visibility !== 'hidden';
                  });
                },
                // Method 2: kix classes
                () => {
                  const kixElements = Array.from(document.querySelectorAll('.kix-appview-editor, .kix-page-content-wrapper, .kix-page'));
                  return kixElements.find(el => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 &&
                           style.display !== 'none' &&
                           style.visibility !== 'hidden';
                  });
                },
                // Method 3: textbox role
                () => {
                  const textboxes = Array.from(document.querySelectorAll('[role="textbox"]'));
                  return textboxes.find(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 100 && rect.height > 100;
                  });
                },
                // Method 4: body as fallback (Google Docs sometimes uses body)
                () => {
                  const body = document.body;
                  const rect = body.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    return body;
                  }
                  return null;
                }
              ];
              
              for (const method of methods) {
                try {
                  const result = method();
                  if (result) {
                    return result;
                  }
                } catch (e) {
                  continue;
                }
              }
              return null;
            });
            
            if (foundEditor && foundEditor.asElement()) {
              editor = foundEditor.asElement();
              editorFound = true;
              console.log('✓ Found editor using page evaluation');
            }
          }
          
          // Strategy 3: Wait longer and try again
          if (!editorFound) {
            console.log('Editor still not found, waiting longer and trying again...');
            await HumanEmulation.randomDelay(3000, 5000);
            
            // Try the most common selector again
            editor = await docsPage.$('[contenteditable="true"]');
            if (editor) {
              const isVisible = await editor.evaluate(el => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              });
              if (isVisible) {
                editorFound = true;
                console.log('✓ Found editor after additional wait');
              }
            }
          }
          
          // Debug: Take screenshot and log page info if editor not found
          if (!editorFound) {
            console.log('⚠ Editor not found, taking debug screenshot...');
            try {
              await docsPage.screenshot({ path: 'google-docs-editor-debug.png', fullPage: true });
              console.log('Screenshot saved as google-docs-editor-debug.png');
            } catch (screenshotError) {
              console.log('Could not take screenshot:', screenshotError.message);
            }
            
            // Log page info
            const pageInfo = await docsPage.evaluate(() => {
              return {
                url: window.location.href,
                title: document.title,
                bodyText: document.body ? document.body.textContent.substring(0, 200) : 'No body',
                contenteditables: document.querySelectorAll('[contenteditable="true"]').length,
                kixElements: document.querySelectorAll('.kix-appview-editor, .kix-page').length,
                textboxes: document.querySelectorAll('[role="textbox"]').length
              };
            });
            console.log('Page info:', pageInfo);
          }
          
          if (editor && editorFound) {
            // Generate exactly 50 words of text
            const fiftyWords = 'This is a comprehensive test document created for profile management and automation testing purposes. The document contains exactly fifty words to demonstrate proper functionality and ensure that the system works correctly when interacting with Google Docs. Each word has been carefully selected to provide meaningful content while testing typing capabilities.';
            
            console.log('Typing 50 words into Google Docs...');
            
            // Click on the editor to focus it
            try {
              await editor.click({ delay: 100 });
              await HumanEmulation.randomDelay(500, 1000);
            } catch (clickErr) {
              // Try focusing via JavaScript
              await docsPage.evaluate(el => {
                if (el) {
                  el.focus();
                  el.click();
                }
              }, editor);
              await HumanEmulation.randomDelay(500, 1000);
            }
            
            // Type the text
            await HumanEmulation.humanType(docsPage, '[contenteditable="true"], .kix-appview-editor', fiftyWords);
            await HumanEmulation.randomDelay(2000, 3000);
            console.log('✓ Typed 50 words in Google Docs');
            
            // Google Docs auto-saves, but we'll trigger Ctrl+S to ensure save
            console.log('Saving document automatically...');
            
            // Method 1: Use Ctrl+S keyboard shortcut
            try {
              await docsPage.keyboard.down('Control');
              await docsPage.keyboard.press('KeyS');
              await docsPage.keyboard.up('Control');
              await HumanEmulation.randomDelay(1000, 2000);
              console.log('✓ Save command sent (Ctrl+S)');
            } catch (saveError) {
              console.log('Ctrl+S failed, but Google Docs auto-saves:', saveError.message);
            }
            
            // Wait for auto-save to complete (Google Docs shows "All changes saved" indicator)
            console.log('Waiting for auto-save to complete...');
            try {
              // Wait for "All changes saved" indicator or check save status
              await docsPage.waitForFunction(
                () => {
                  const saveIndicator = document.querySelector('[aria-label*="saved" i], [title*="saved" i], .docs-save-indicator');
                  if (saveIndicator) {
                    const text = (saveIndicator.textContent || saveIndicator.getAttribute('aria-label') || '').toLowerCase();
                    return text.includes('saved') || text.includes('all changes');
                  }
                  // Also check if there's no "Saving..." indicator
                  const savingIndicator = document.querySelector('[aria-label*="saving" i], [title*="saving" i]');
                  return !savingIndicator;
                },
                { timeout: 10000 }
              );
              console.log('✓ Document auto-saved successfully');
            } catch (saveWaitError) {
              // If we can't detect save status, just wait a bit longer
              console.log('Could not verify save status, but Google Docs auto-saves');
              await HumanEmulation.randomDelay(2000, 3000);
            }
            
            // Additional wait to ensure save is complete
            await HumanEmulation.randomDelay(1000, 2000);
            console.log('✓ Document save process completed');
            
            // Close the Google Docs tab using Ctrl+W
            console.log('Closing Google Docs tab with Ctrl+W...');
            try {
              // Make sure we're on the Google Docs tab before closing
              // IMPORTANT: docsPage must be a different tab from page
              if (!docsPage.isClosed() && docsPage !== page) {
                // Bring Google Docs tab to front and wait for it to be fully active
                await docsPage.bringToFront();
                await HumanEmulation.randomDelay(2000, 3000); // Longer wait to ensure tab is active
                
                // Verify we're on the Google Docs tab
                const currentUrl = docsPage.url();
                console.log(`Current tab URL before closing: ${currentUrl}`);
                
                // Close the tab programmatically (skip Ctrl+W, more reliable)
                console.log('Closing Google Docs tab programmatically...');
                try {
                  if (!docsPage.isClosed()) {
                    await docsPage.close();
                    await HumanEmulation.randomDelay(2000, 3000);
                    console.log('✓ Google Docs tab closed');
        } else {
                    console.log('✓ Google Docs tab already closed');
                  }
                } catch (closeError) {
                  console.log('Error closing tab:', closeError.message);
                  // Try one more time after a delay
                  try {
                    await HumanEmulation.randomDelay(1000, 2000);
                    if (!docsPage.isClosed()) {
                      await docsPage.close();
                      console.log('✓ Tab closed on retry');
                    }
                  } catch (retryError) {
                    console.log('Retry close also failed:', retryError.message);
                  }
                }
                
                // Now switch to the original Google Drive tab
                // Browser should have already switched, but ensure we're on it
                if (!page.isClosed()) {
                  await page.bringToFront();
                  await HumanEmulation.randomDelay(1000, 1500);
                  console.log('✓ Returned to Google Drive tab');
                }
              } else if (docsPage === page) {
                // If docsPage is the same as page, we're on the same tab
                // Just navigate back to Google Drive (no need to close)
                console.log('Same tab detected, navigating back to Google Drive...');
                  await page.goto('https://drive.google.com/?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
                console.log('✓ Navigated back to Google Drive');
              } else {
                console.log('Google Docs tab already closed');
                // If docsPage is closed, just switch to original page
                if (!page.isClosed()) {
                  await page.bringToFront();
                  console.log('✓ Returned to Google Drive tab');
                }
              }
            } catch (closeError) {
              console.log('Error closing tab with Ctrl+W:', closeError.message);
              // Fallback: try to close programmatically
              try {
                if (!docsPage.isClosed() && docsPage !== page) {
                  await docsPage.close();
                  console.log('✓ Closed Google Docs tab programmatically (fallback)');
                }
                if (!page.isClosed()) {
                  await page.bringToFront();
                }
              } catch (fallbackError) {
                console.log('Fallback close failed:', fallbackError.message);
              }
            }
          } else {
            console.log('⚠ Editor not found in Google Docs tab');
            console.log(`Current URL: ${docsPage.url()}`);
            
            // Still try to close tab with Ctrl+W and return to original tab
            try {
              if (!docsPage.isClosed()) {
                await docsPage.bringToFront();
                await HumanEmulation.randomDelay(500, 1000);
                
                // Press Ctrl+W to close the tab
                await docsPage.keyboard.down('Control');
                await docsPage.keyboard.press('KeyW');
                await docsPage.keyboard.up('Control');
                await HumanEmulation.randomDelay(1000, 2000);
                console.log('✓ Closed Google Docs tab with Ctrl+W (even though editor not found)');
              }
              
              // Switch back to original page
              if (!page.isClosed()) {
                await page.bringToFront();
                console.log('✓ Returned to Google Drive tab');
              }
            } catch (closeError) {
              console.log('Error closing tab:', closeError.message);
            }
          }
        } else {
          console.log('Google Docs option not found in menu');
        }
      } else {
        console.log('New/Create button not found on Google Drive, trying alternative interaction...');
        
        // Alternative: Just browse files in Drive
        try {
          await HumanEmulation.randomDelay(2000, 3000);
          
          // Scroll through Drive files
          await page.evaluate(() => window.scrollBy(0, 300));
          await HumanEmulation.randomDelay(2000, 3000);
          await HumanEmulation.simulateReading(page, 2000 + Math.random() * 2000);
          
          // Try clicking on a file if available
          const fileClicked = await page.evaluate(() => {
            const files = Array.from(document.querySelectorAll('[role="gridcell"], [data-id]'));
            for (const file of files.slice(0, 5)) {
              const rect = file.getBoundingClientRect();
              const style = window.getComputedStyle(file);
              if (rect.width > 0 && rect.height > 0 && 
                  style.display !== 'none' && 
                  style.visibility !== 'hidden') {
                file.click();
                return true;
              }
            }
            return false;
          });
          
          if (fileClicked) {
            console.log('✓ Clicked on a Drive file');
            await HumanEmulation.randomDelay(3000, 5000);
            await page.goBack({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
          }
          
          console.log('✓ Browsed Google Drive files');
        } catch (browseError) {
          console.log(`Drive browsing error: ${browseError.message}`);
        }
      }

      try {
        const log = new InteractionLog({
          profileId,
          action: 'google_drive',
          url: 'https://drive.google.com',
          success: true
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save Google Drive log:', logError);
      }
    } catch (error) {
      console.error('Google Drive error:', error.message);
      
      // Even if there's an error, try to at least browse Drive
      if (!page.isClosed()) {
        try {
          console.log('Attempting fallback: browsing Google Drive...');
          await page.goto('https://drive.google.com/?hl=en', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
          await this.handlePopupsAndModals(page);
          await HumanEmulation.randomDelay(2000, 3000);
          
          // Just scroll and read
          await page.evaluate(() => window.scrollBy(0, 400));
          await HumanEmulation.randomDelay(2000, 3000);
          await HumanEmulation.simulateReading(page, 3000 + Math.random() * 2000);
          
          console.log('✓ Completed fallback Google Drive browsing');
        } catch (fallbackError) {
          console.log(`Fallback Drive browsing also failed: ${fallbackError.message}`);
        }
      }
      
      // Handle frame detachment errors gracefully
      if (error.message && (error.message.includes('detached') || 
          error.message.includes('Requesting main frame too early') ||
          error.message.includes('not clickable') ||
          error.message.includes('not an Element'))) {
        console.log('Page/frame detached or element not clickable during Google Drive operation');
        return;
      }
      
      try {
        const log = new InteractionLog({
          profileId,
          action: 'google_drive',
          url: 'https://drive.google.com',
          success: false,
          error: error.message
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save error log:', logError);
      }
    }
  }

  async useGoogleMaps(page, profileId, proxy) {
    console.log('🗺️  Starting Google Maps farming...');
    try {
      // Check if page is still valid
      if (page.isClosed()) {
        console.log('Page closed, skipping Google Maps');
        return;
      }
      
      console.log('Navigating to Google Maps...');
      await page.goto('https://maps.google.com/?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
      await this.handlePopupsAndModals(page);
      await HumanEmulation.randomDelay(3000, 5000);
      
      // Scroll to top to ensure search box is visible
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await HumanEmulation.randomDelay(1000, 2000);

      // Try multiple selectors for Google Maps search box (prioritize most common)
      const searchBoxSelectors = [
        'input[id="UGojuc"]',
        'input[jslog="11886"]'
      ];
      
      let searchBox = null;
      let searchSelector = null;
      
      // Strategy 1: Wait for search box with timeout
      for (const selector of searchBoxSelectors) {
        try {
          console.log(`Trying search box selector: ${selector}`);
          await page.waitForSelector(selector, { timeout: 5000, visible: true });
          searchBox = await page.$(selector);
      if (searchBox) {
            const isVisible = await searchBox.evaluate(el => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              const inViewport = rect.top >= 0 && rect.left >= 0 && 
                               rect.bottom <= window.innerHeight && 
                               rect.right <= window.innerWidth;
              return rect.width > 0 && rect.height > 0 && 
                     style.display !== 'none' && 
                     style.visibility !== 'hidden' &&
                     style.opacity !== '0' &&
                     el.offsetParent !== null &&
                     inViewport;
            });
            if (isVisible) {
              searchSelector = selector;
              console.log(`✓ Found search box using selector: ${selector}`);
              break;
            } else {
              console.log(`Element found but not visible/in viewport: ${selector}`);
            }
          }
        } catch (e) {
          console.log(`Selector failed: ${selector}`);
          continue;
        }
      }
      
      // Strategy 2: Find by evaluating page
      if (!searchBox) {
        console.log('Search box not found by selectors, trying evaluate method...');
        const foundSearchBox = await page.evaluateHandle(() => {
          // Find all input elements
          const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'));
          
          for (const input of inputs) {
            const placeholder = (input.placeholder || '').toLowerCase();
            const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            const name = (input.name || '').toLowerCase();
            const className = (input.className || '').toLowerCase();
            const ariaControls = (input.getAttribute('aria-controls') || '').toLowerCase();
            const parent = input.closest('div, form, section');
            const parentText = (parent?.textContent || '').toLowerCase();
            
            // Check if it's likely a search box
            const isSearchBox = placeholder.includes('search') || 
                               placeholder.includes('buscar') ||
                               ariaLabel.includes('search') ||
                               ariaLabel.includes('buscar') ||
                               id.includes('search') ||
                               id.includes('searchbox') ||
                               name.includes('search') ||
                               className.includes('search') ||
                               ariaControls.includes('search') ||
                               parentText.includes('search');
            
            if (isSearchBox) {
              const rect = input.getBoundingClientRect();
              const style = window.getComputedStyle(input);
              if (rect.width > 0 && rect.height > 0 && 
                  style.display !== 'none' && 
                  style.visibility !== 'hidden' &&
                  input.offsetParent !== null) {
                console.log('Found potential search box:', {
                  id: input.id,
                  placeholder,
                  ariaLabel,
                  className
                });
                return input;
              }
            }
          }
          return null;
        });
        
        if (foundSearchBox && foundSearchBox.asElement()) {
          searchBox = foundSearchBox.asElement();
          console.log('✓ Found search box using evaluate method');
        }
      }
      
      // Strategy 3: Try clicking search icon/button first
      if (!searchBox) {
        console.log('Trying to find search box by clicking search area...');
        try {
          // Look for search icon or search button to click
          const searchIcon = await page.evaluateHandle(() => {
            const icons = Array.from(document.querySelectorAll('button, div[role="button"], a, [data-value*="search"]'));
            return icons.find(icon => {
              const ariaLabel = (icon.getAttribute('aria-label') || '').toLowerCase();
              const text = (icon.textContent || '').toLowerCase();
              const dataValue = (icon.getAttribute('data-value') || '').toLowerCase();
              return ariaLabel.includes('search') || 
                     text.includes('search') ||
                     dataValue.includes('search');
            });
          });
          
          if (searchIcon && searchIcon.asElement()) {
            await searchIcon.asElement().click({ delay: 100 });
            await HumanEmulation.randomDelay(1000, 2000);
            
            // Now try to find search box again
            for (const selector of searchBoxSelectors.slice(0, 5)) {
              try {
                searchBox = await page.$(selector);
                if (searchBox) {
                  searchSelector = selector;
                  console.log(`✓ Found search box after clicking search icon: ${selector}`);
                  break;
                }
              } catch (e) {
                continue;
              }
            }
          }
        } catch (e) {
          console.log('Could not find search icon:', e.message);
        }
      }
      
      if (searchBox) {
        try {
          // Scroll element into view
          await searchBox.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          await HumanEmulation.randomDelay(500, 1000);
          
          // Try to click using selector first (more reliable)
          if (searchSelector) {
            try {
              await page.click(searchSelector, { delay: 100 });
            } catch (clickError) {
              // If selector click fails, try element click
              try {
                await searchBox.click({ delay: 100, clickCount: 3 });
              } catch (elementClickError) {
                // If both fail, try JavaScript click
                await searchBox.evaluate(el => {
                  el.focus();
                  el.click();
                });
              }
            }
          } else {
            // Try element click, fallback to JavaScript
            try {
              await searchBox.click({ delay: 100, clickCount: 3 });
            } catch (clickError) {
              await searchBox.evaluate(el => {
                el.focus();
                el.click();
              });
            }
          }
          
          await HumanEmulation.randomDelay(500, 1000);
          
          // Clear any existing text
          try {
            await page.keyboard.down('Control');
            await page.keyboard.press('KeyA');
            await page.keyboard.up('Control');
            await HumanEmulation.randomDelay(100, 200);
            await page.keyboard.press('Backspace');
          await HumanEmulation.randomDelay(200, 500);
          } catch (clearError) {
            console.log('Could not clear search box, continuing anyway...');
          }
          
          // Type the search query
          console.log('Typing "Coffee" into search box...');
          if (searchSelector) {
            try {
              await HumanEmulation.humanType(page, searchSelector, 'Coffee');
            } catch (typeError) {
              // Fallback to direct typing
          await searchBox.type('Coffee', { delay: 50 + Math.random() * 50 });
            }
          } else {
            await searchBox.type('Coffee', { delay: 50 + Math.random() * 50 });
          }
          await HumanEmulation.randomDelay(1000, 2000);
          console.log('✓ Successfully typed "Coffee" into search box');
        } catch (typeError) {
          if (typeError.message.includes('detached') || typeError.message.includes('not clickable')) {
            console.log('Search box not usable, trying alternative method...');
            // Try typing directly using keyboard
            try {
              // Focus the page first
              await page.evaluate(() => document.body.focus());
              await page.keyboard.type('Coffee', { delay: 50 + Math.random() * 50 });
              await HumanEmulation.randomDelay(1000, 2000);
              console.log('✓ Typed "Coffee" using keyboard method');
            } catch (keyboardError) {
              console.log('Failed to type into search box:', keyboardError.message);
              // Last resort: try setting value via JavaScript
              try {
                await page.evaluate((sel) => {
                  const input = document.querySelector(sel || 'input[id*="search"]');
                  if (input) {
                    input.focus();
                    input.value = 'Coffee';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }, searchSelector);
                console.log('✓ Set search value via JavaScript');
              } catch (jsError) {
                console.log('All methods failed to type into search box');
            return;
          }
            }
          } else {
          throw typeError;
          }
        }
      } else {
        console.log('⚠ Search box not found on Google Maps');
        // Take screenshot for debugging
        try {
          await page.screenshot({ path: 'google-maps-search-debug.png' });
          console.log('Screenshot saved as google-maps-search-debug.png');
        } catch (e) {
          console.log('Could not take screenshot:', e.message);
        }
        return;
        }
        
        if (page.isClosed()) {
          console.log('Page closed during Google Maps search');
          return;
        }
        
        await page.keyboard.press('Enter');
      await HumanEmulation.randomDelay(4000, 6000);

        if (page.isClosed()) {
          console.log('Page closed after Google Maps search');
          return;
        }

      // Wait for search results to load
      console.log('Waiting for Google Maps search results...');
      await HumanEmulation.randomDelay(3000, 5000);
      
      // Find and click on a listing/place from search results
      console.log('Looking for place listings...');
      const listingClicked = await page.evaluate(() => {
        // Try multiple selectors for place listings
        const listingSelectors = [
          '[data-result-index]',
          '[jsaction*="place"]',
          'div[role="button"][data-value]',
          'div[data-value*="place"]',
          '.Nv2PK',
          '[class*="result"]',
          '[class*="listing"]'
        ];
        
        for (const selector of listingSelectors) {
          const elements = Array.from(document.querySelectorAll(selector));
          for (const el of elements.slice(0, 5)) {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isVisible = rect.width > 0 && rect.height > 0 && 
                             style.display !== 'none' && 
                             style.visibility !== 'hidden' &&
                             el.offsetParent !== null;
            
            if (isVisible) {
              // Check if it looks like a place listing (has text content)
              const text = el.textContent?.trim() || '';
              if (text.length > 10 && !text.toLowerCase().includes('directions')) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.click();
                return { clicked: true, text: text.substring(0, 50) };
              }
            }
          }
        }
        
        // Fallback: try clicking on any clickable element in the results panel
        const resultsPanel = document.querySelector('[role="main"], #pane, [class*="results"]');
        if (resultsPanel) {
          const clickableElements = Array.from(resultsPanel.querySelectorAll('div[role="button"], a, [jsaction*="click"]'));
          for (const el of clickableElements.slice(0, 3)) {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (rect.width > 0 && rect.height > 0 && 
                style.display !== 'none' && 
                style.visibility !== 'hidden') {
              const text = el.textContent?.trim() || '';
              if (text.length > 5) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.click();
                return { clicked: true, text: text.substring(0, 50) };
              }
            }
          }
        }
        
        return { clicked: false };
      });
      
      if (listingClicked.clicked) {
        console.log(`✓ Clicked on listing: ${listingClicked.text}...`);
        await HumanEmulation.randomDelay(4000, 6000);
        
        // Wait for listing details to load
        await this.handlePopupsAndModals(page);
        await HumanEmulation.randomDelay(2000, 3000);
        
        // Scroll through listing details
        await page.evaluate(() => window.scrollBy(0, 300));
        await HumanEmulation.randomDelay(2000, 3000);
        await HumanEmulation.simulateReading(page, 3000 + Math.random() * 2000);
        
        // Scroll to see more details
        await page.evaluate(() => window.scrollBy(0, 400));
        await HumanEmulation.randomDelay(2000, 3000);
        await HumanEmulation.simulateReading(page, 2000 + Math.random() * 2000);
        
        // Try to click on directions button
        console.log('Looking for Directions button...');
        const directionsButton = await page.$('button[aria-label*="Directions" i], button[data-value="Directions"], button[jsaction*="directions"]');
        if (directionsButton) {
          try {
            const isVisible = await page.evaluate((el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            }, directionsButton);
            
            if (isVisible) {
              await directionsButton.scrollIntoView();
              await HumanEmulation.randomDelay(500, 1000);
              await directionsButton.click();
              console.log('✓ Clicked Directions button');
              await HumanEmulation.randomDelay(3000, 5000);
              
              // Scroll in directions view
              await page.evaluate(() => window.scrollBy(0, 300));
              await HumanEmulation.randomDelay(2000, 3000);
              await HumanEmulation.simulateReading(page, 3000 + Math.random() * 2000);
              
              // Go back to listing
              await page.goBack({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
              await HumanEmulation.randomDelay(2000, 3000);
            }
          } catch (dirClickError) {
            console.log(`Directions button error: ${dirClickError.message}`);
          }
        }
      } else {
        console.log('⚠ No listing found to click, interacting with map instead...');
        
        // Scroll and interact with map
        await page.evaluate(() => window.scrollBy(0, 200));
        await HumanEmulation.randomDelay(2000, 3000);
        
        // Zoom in/out on map (simulate mouse wheel)
        await page.evaluate(() => {
          const mapContainer = document.querySelector('#map, [role="main"]');
          if (mapContainer) {
            mapContainer.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
          }
        });
        await HumanEmulation.randomDelay(2000, 3000);
        
        await page.evaluate(() => {
          const mapContainer = document.querySelector('#map, [role="main"]');
          if (mapContainer) {
            mapContainer.dispatchEvent(new WheelEvent('wheel', { deltaY: 50, bubbles: true }));
          }
        });
        await HumanEmulation.randomDelay(2000, 3000);
      }

      try {
        const log = new InteractionLog({
          profileId,
          action: 'google_maps',
          url: 'https://maps.google.com',
          success: true
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save Google Maps log:', logError);
      }
    } catch (error) {
      console.error('Google Maps error:', error);
      
      // Handle frame detachment errors gracefully
      if (error.message.includes('detached') || 
          error.message.includes('Requesting main frame too early') ||
          error.message.includes('not clickable') ||
          error.message.includes('not an Element')) {
        console.log('Page/frame detached or element not clickable during Google Maps operation, skipping');
        return;
      }
      
      try {
        const log = new InteractionLog({
          profileId,
          action: 'google_maps',
          url: 'https://maps.google.com',
          success: false,
          error: error.message
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save error log:', logError);
      }
    }
  }
  async clickInternalLinks(page, profileId) {
    try {
      if (page.isClosed()) return;
      
      const currentUrl = page.url();
      let currentDomain;
      try {
        currentDomain = new URL(currentUrl).hostname;
      } catch {
        console.log('Could not parse current URL for internal links');
        return;
      }
      
      console.log(`Looking for internal links on ${currentDomain}...`);
      
      const internalLinks = await page.evaluate((domain) => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        const foundLinks = [];
        
        for (const link of links) {
          const href = link.getAttribute('href');
          if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
          
          // Skip common non-content links (language-agnostic)
          const linkText = (link.textContent || '').toLowerCase().trim();
          const ariaLabel = (link.getAttribute('aria-label') || '').toLowerCase();
          const title = (link.getAttribute('title') || '').toLowerCase();
          const combinedText = `${linkText} ${ariaLabel} ${title}`;
          
          // Skip social media share buttons, navigation, and non-content links
          const skipPatterns = [
            'cookie', 'privacy', 'terms', 'login', 'sign in', 'sign up', 'menu', 'skip',
            'share', 'twitter', 'facebook', 'linkedin', 'pinterest', 'reddit', 'whatsapp',
            'telegram', 'email', 'print', 'bookmark', 'favorite', 'follow', 'subscribe',
            'newsletter', 'rss', 'feed', 'comment', 'reply', 'like', 'dislike', 'vote',
            'opens in new window', 'opens in new tab', 'external link', 'read more',
            'continue reading', 'next', 'previous', 'back', 'home', 'top', 'bottom', 'close',
            'dismiss', 'no thanks', 'not now', 'maybe later'
          ];
          if (skipPatterns.some(pattern => combinedText.includes(pattern))) continue;
          
          // Skip links that are likely share buttons (check for social media icons/classes)
          const parent = link.closest('div, span, button, nav, header, footer');
          const parentClass = (parent?.className || '').toLowerCase();
          const parentId = (parent?.id || '').toLowerCase();
          if (parentClass.includes('share') || parentClass.includes('social') || 
              parentId.includes('share') || parentId.includes('social') ||
              link.classList.contains('share') || link.classList.contains('social') ||
              parentClass.includes('nav') || parentClass.includes('menu') ||
              parentClass.includes('header') || parentClass.includes('footer')) {
            continue;
          }
          
          // Check if link is visible
          const rect = link.getBoundingClientRect();
          const style = window.getComputedStyle(link);
          const isVisible = rect.width > 0 && rect.height > 0 && 
                           style.display !== 'none' && 
                           style.visibility !== 'hidden' &&
                           style.opacity !== '0' &&
                           link.offsetParent !== null;
          
          if (!isVisible) continue;
          
          // Check if link has meaningful text
          if (linkText.length < 2 && !ariaLabel && !title) continue;
          
          // Check if it's an internal link
          try {
            const url = new URL(href, window.location.href);
            const linkDomain = url.hostname.toLowerCase();
            const baseDomain = domain.toLowerCase();
            
            // Match exact domain or subdomain
            if (linkDomain === baseDomain || linkDomain.endsWith('.' + baseDomain)) {
              // Prefer links with more text (likely content links)
              foundLinks.push({
                href: href,
                fullUrl: url.href,
                text: linkText || ariaLabel || title || href,
                textLength: linkText.length
              });
            }
          } catch {
            // If URL parsing fails, check if it's a relative path
            if (href.startsWith('/') || href.startsWith('./') || !href.startsWith('http')) {
              foundLinks.push({
                href: href,
                fullUrl: new URL(href, window.location.href).href,
                text: linkText || ariaLabel || title || href,
                textLength: linkText.length
              });
            }
          }
          
          if (foundLinks.length >= 10) break;
        }
        
        // Sort by text length (prefer links with more descriptive text)
        foundLinks.sort((a, b) => b.textLength - a.textLength);
        
        return foundLinks.slice(0, 5);
      }, currentDomain);
      
      if (internalLinks.length === 0) {
        console.log('No suitable internal links found');
        return;
      }
      
      console.log(`Found ${internalLinks.length} internal link(s)`);
      
      // Select a random link from the top 3 (prefer better links but add variety)
      const linkToClick = internalLinks[Math.floor(Math.random() * Math.min(3, internalLinks.length))];
      
      console.log(`Opening internal link in new tab: "${linkToClick.text.substring(0, 60)}..." (${linkToClick.href})`);
      
      const browser = page.browser();
      const originalPages = await browser.pages();
      const originalPageCount = originalPages.length;
      
      // Find the link element and open it in a new tab using Ctrl+Click
      const linkFound = await page.evaluate((targetHref, targetFullUrl) => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        
        for (const link of links) {
          const linkHref = link.getAttribute('href');
          if (!linkHref) continue;
          
          try {
            const linkUrl = new URL(linkHref, window.location.href);
            const targetUrl = new URL(targetFullUrl);
            
            // Match by full URL or pathname
            if (linkUrl.href === targetUrl.href || 
                linkUrl.pathname === targetUrl.pathname ||
                linkHref === targetHref) {
              // Scroll into view
              link.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return { found: true, href: linkHref };
            }
          } catch {
            // Fallback: simple string matching
            if (linkHref === targetHref || linkHref.includes(targetHref) || targetHref.includes(linkHref)) {
              link.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return { found: true, href: linkHref };
            }
          }
        }
        return { found: false };
      }, linkToClick.href, linkToClick.fullUrl);
      
      if (!linkFound.found) {
        console.log('Could not find internal link, trying alternative method...');
        const linkFoundAlt = await page.evaluate((linkText) => {
          const links = Array.from(document.querySelectorAll('a[href]'));
          for (const link of links) {
            const text = (link.textContent || '').toLowerCase().trim();
            if (text && text.includes(linkText.toLowerCase().substring(0, 20))) {
              link.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return { found: true, href: link.getAttribute('href') };
            }
          }
          return { found: false };
        }, linkToClick.text);
        
        if (!linkFoundAlt.found) {
          console.log('Could not find internal link with alternative method either');
          return;
        }
      }
      
      // Use Ctrl+Click to open in new tab
      await HumanEmulation.randomDelay(500, 1000);
      
      // Find the link element handle
      const linkHandle = await page.evaluateHandle((targetHref, targetFullUrl) => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        
        for (const link of links) {
          const linkHref = link.getAttribute('href');
          if (!linkHref) continue;
          
          try {
            const linkUrl = new URL(linkHref, window.location.href);
            const targetUrl = new URL(targetFullUrl || targetHref, window.location.href);
            
            // Match by full URL or pathname
            if (linkUrl.href === targetUrl.href || 
                linkUrl.pathname === targetUrl.pathname ||
                linkHref === targetHref) {
              link.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return link;
            }
          } catch {
            // Fallback: simple string matching
            if (linkHref === targetHref || linkHref.includes(targetHref) || targetHref.includes(linkHref)) {
              link.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return link;
            }
          }
        }
        return null;
      }, linkToClick.href, linkToClick.fullUrl);
      
      let clicked = false;
      if (linkHandle && linkHandle.asElement()) {
        try {
          // Click with Ctrl key modifier to open in new tab
          await linkHandle.asElement().click({ modifiers: ['Control'] });
          clicked = true;
        } catch (e) {
          console.log('Ctrl+Click failed, trying alternative method...');
        }
      }
      
      if (!clicked) {
        // Fallback: try clicking by text
        const linkHandleAlt = await page.evaluateHandle((linkText) => {
          const links = Array.from(document.querySelectorAll('a[href]'));
          for (const link of links) {
            const text = (link.textContent || '').toLowerCase().trim();
            if (text && text.includes(linkText.toLowerCase().substring(0, 20))) {
              link.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return link;
            }
          }
          return null;
        }, linkToClick.text);
        
        if (linkHandleAlt && linkHandleAlt.asElement()) {
          try {
            await linkHandleAlt.asElement().click({ modifiers: ['Control'] });
            clicked = true;
          } catch (e) {
            console.log('Alternative Ctrl+Click also failed');
          }
        }
      }
      
      if (!clicked) {
        console.log('Could not click link with Ctrl modifier, opening URL directly in new tab...');
        // Last resort: open URL directly in new tab
        const newTab = await browser.newPage();
        await newTab.goto(linkToClick.fullUrl || linkToClick.href, { waitUntil: 'networkidle2', timeout: 30000 });
        await this.handlePopupsAndModals(newTab);
        await HumanEmulation.randomDelay(2000, 3000);
        await HumanEmulation.simulateReading(newTab, 2000 + Math.random() * 2000);
        await newTab.close();
        console.log('✓ Closed new tab and returned to original page');
        return;
      }
      
      await HumanEmulation.randomDelay(1000, 2000);
      
      // Wait for new tab to open
      let newTab = null;
      const maxWaitTime = 5000;
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWaitTime && !newTab) {
        const currentPages = await browser.pages();
        if (currentPages.length > originalPageCount) {
          const newPages = currentPages.slice(originalPageCount);
          for (const p of newPages) {
            try {
              const url = p.url();
              if (url && url !== 'about:blank' && !url.includes('start.adspower.net')) {
                newTab = p;
                console.log(`✓ New tab opened: ${url}`);
                break;
              }
            } catch {}
          }
        }
        if (!newTab) {
          await HumanEmulation.randomDelay(300, 500);
        }
      }
      
      if (!newTab) {
        console.log('⚠ New tab not detected, trying direct navigation...');
        // Fallback: open URL directly in new tab
        newTab = await browser.newPage();
        await newTab.goto(linkToClick.fullUrl || linkToClick.href, { waitUntil: 'networkidle2', timeout: 30000 });
      }
      
      if (newTab) {
        await this.handlePopupsAndModals(newTab);
        await HumanEmulation.randomDelay(2000, 3000);
        await HumanEmulation.simulateReading(newTab, 2000 + Math.random() * 2000);
        
        // Close the new tab
        await newTab.close();
        console.log('✓ Closed new tab and returned to original page');
        await HumanEmulation.randomDelay(500, 1000);
      }
    } catch (error) {
      console.log(`Error clicking internal links: ${error.message}`);
    }
  }

  async copyTextOfInterest(page, profileId) {
    try {
      if (page.isClosed()) return;
      
      const textToCopy = await page.evaluate(() => {
        // Use language-agnostic selectors - works on any language
        const selectors = ['p', 'article', '.content', '.article-content', '[role="article"]', 'main p', '.post-content p'];
        let paragraphs = [];
        
        for (const selector of selectors) {
          paragraphs = Array.from(document.querySelectorAll(selector));
          if (paragraphs.length > 0) break;
        }
        
        const interestingTexts = paragraphs
          .filter(p => {
            const text = p.textContent?.trim() || '';
            // Language-agnostic: more flexible length requirements
            // Filter out very short text, navigation/menu text, and social media buttons
            const isTooShort = text.length < 30;
            const isTooLong = text.length > 2000; // Increased from 500
            const isNavigation = /^(cookie|privacy|terms|menu|skip|login|sign|share|follow|subscribe|newsletter|rss|feed)/i.test(text);
            const isSocialMedia = /(twitter|facebook|linkedin|pinterest|instagram|youtube|share on|follow us|like us)/i.test(text);
            const isButton = p.closest('button, .button, [role="button"]') !== null;
            
            return !isTooShort && !isTooLong && !isNavigation && !isSocialMedia && !isButton;
          })
          .map(p => p.textContent.trim());
        
        if (interestingTexts.length === 0) return null;
        return interestingTexts[Math.floor(Math.random() * interestingTexts.length)];
      });
      
      if (!textToCopy) {
        console.log('No suitable text found to copy (language-agnostic)');
        return;
      }
      
      console.log(`Copying text of interest (${textToCopy.length} chars)...`);
      
      const copied = await page.evaluate((text) => {
        try {
          const selection = window.getSelection();
          const range = document.createRange();
          const selectors = ['p', 'article', '.content'];
          let targetP = null;
          
          for (const selector of selectors) {
            const paragraphs = Array.from(document.querySelectorAll(selector));
            targetP = paragraphs.find(p => p.textContent.includes(text));
            if (targetP) break;
          }
          
          if (targetP) {
            range.selectNodeContents(targetP);
            selection.removeAllRanges();
            selection.addRange(range);
            return true;
          }
          return false;
        } catch {
          return false;
        }
      }, textToCopy);
      
      if (!copied) {
        console.log('Could not select text for copying');
        return;
      }
      
      await HumanEmulation.randomDelay(500, 1000);
      
      await page.keyboard.down('Control');
      await page.keyboard.press('c');
      await page.keyboard.up('Control');
      
      await HumanEmulation.randomDelay(500, 1000);
      
      await page.evaluate(() => window.getSelection().removeAllRanges());
    } catch (error) {
      console.log(`Error copying text: ${error.message}`);
      // Don't throw - just log and continue
    }
  }

  async bookmarkPage(page, profileId) {
    try {
      if (page.isClosed()) return;
      
      console.log('Bookmarking page...');
      
      const bookmarked = await page.evaluate(() => {
        if (window.chrome && window.chrome.bookmarks) {
          window.chrome.bookmarks.create({
            title: document.title,
            url: window.location.href
          });
          return true;
        }
        
        try {
          const starButton = document.querySelector('button[aria-label*="bookmark" i], button[aria-label*="favorite" i], button[title*="bookmark" i]');
          if (starButton) {
            starButton.click();
            return true;
          }
        } catch {}
        
        return false;
      });
      
      if (bookmarked) {
        await HumanEmulation.randomDelay(1000, 2000);
        console.log('✓ Page bookmarked');
      }
    } catch (error) {
      console.log(`Error bookmarking page: ${error.message}`);
    }
  }

  async farmYouTube(page, profileId, searchQueries) {
    console.log('🎬 Starting YouTube farming...');
    const originalPage = page;
    const browser = page.browser();
    
    try {
      // Check if YouTube account exists or is banned (re-fetch to get latest notes)
      const profile = await Profile.findById(profileId);
      if (!profile) {
        console.log('⚠ Profile not found, skipping YouTube farming');
        return;
      }
      
      const notes = (profile.notes || '').toLowerCase();
      const hasNoAccount = notes.includes('no youtube account');
      const isBanned = notes.includes('banned youtube');
      
      if (hasNoAccount) {
        console.log(`⚠ Skipping YouTube farming - account does not exist (from DNA analysis)`);
        console.log(`  Profile notes: ${notes}`);
        return;
      }
      
      if (isBanned) {
        console.log(`⚠ Skipping YouTube farming - account is banned`);
        console.log(`  Profile notes: ${notes}`);
        return;
      }
      
      if (page.isClosed()) {
        console.log('Page closed, skipping YouTube farming');
        return;
      }
      
      if (!searchQueries || searchQueries.length === 0) {
        console.log('⚠ No search queries provided, skipping YouTube');
        return;
      }
      
      const query = searchQueries[Math.floor(Math.random() * searchQueries.length)];
      console.log(`🔍 Searching YouTube with query: "${query}"`);
      
      await page.goto('https://www.youtube.com/?hl=en&gl=US', { waitUntil: 'networkidle2', timeout: 30000 });
      await this.handlePopupsAndModals(page);
      await HumanEmulation.randomDelay(3000, 5000);
      
      // Scroll down a bit to simulate human behavior
      await page.evaluate(() => window.scrollBy(0, 200));
      await HumanEmulation.randomDelay(1000, 2000);
      
      if (page.isClosed()) return;
      
      const searchBoxSelectors = [
        'input[name="search_query"]',
        'input[id="search"]',
        'input[placeholder*="Search"]',
        'input[aria-label*="Search"]'
      ];
      
      let searchBox = null;
      for (const selector of searchBoxSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          searchBox = await page.$(selector);
          if (searchBox) break;
        } catch {}
      }
      
      if (!searchBox) {
        console.log('YouTube search box not found');
        return;
      }
      
      await HumanEmulation.humanType(page, searchBoxSelectors.find(s => searchBox), query);
      await HumanEmulation.randomDelay(1500, 2500);
      await page.keyboard.press('Enter');
      await this.waitForNavigation(page, { waitUntil: 'networkidle2', timeout: 30000 });
      await HumanEmulation.randomDelay(3000, 5000);
      
      // Scroll through search results
      await page.evaluate(() => window.scrollBy(0, 300));
      await HumanEmulation.randomDelay(2000, 3000);
      await page.evaluate(() => window.scrollBy(0, 200));
      await HumanEmulation.randomDelay(1500, 2500);
      
      if (page.isClosed()) return;
      
      const videoLinks = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/watch"]'));
        return links
          .filter(link => {
            const href = link.getAttribute('href');
            return href && href.includes('/watch?v=');
          })
          .slice(0, 5)
          .map(link => ({
            href: link.getAttribute('href'),
            title: link.getAttribute('title') || link.textContent?.trim() || ''
          }));
      });
      
      if (videoLinks.length === 0) {
        console.log('No YouTube videos found');
        return;
      }
      
      const videoToWatch = videoLinks[Math.floor(Math.random() * Math.min(3, videoLinks.length))];
      console.log(`🎥 Watching video: ${videoToWatch.title.substring(0, 50)}...`);
      
      // Click on the video link
      const videoClicked = await page.evaluate((href) => {
        const links = Array.from(document.querySelectorAll('a[href*="/watch"]'));
        for (const link of links) {
          const linkHref = link.getAttribute('href');
          if (linkHref && (linkHref === href || linkHref.includes(href.split('?')[0]))) {
            link.scrollIntoView({ behavior: 'smooth', block: 'center' });
            link.click();
            return true;
          }
        }
        return false;
      }, videoToWatch.href);
      
      if (!videoClicked) {
        console.log('⚠ Could not click video link, trying direct navigation...');
        await page.goto(`https://www.youtube.com${videoToWatch.href}`, { waitUntil: 'networkidle2', timeout: 30000 });
      } else {
        await this.waitForNavigation(page, { waitUntil: 'networkidle2', timeout: 30000 });
      }
      
      await this.handlePopupsAndModals(page);
      await HumanEmulation.randomDelay(4000, 6000);
      
      if (page.isClosed()) return;
      
      // Wait for video player to load
      console.log('Waiting for video player to load...');
      await page.waitForSelector('video, .html5-video-player, #movie_player', { timeout: 10000 }).catch(() => {
        console.log('Video player selector not found, continuing anyway...');
      });
      
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Try to play the video
      console.log('Attempting to play video...');
      const videoPlaying = await page.evaluate(() => {
        // Try multiple methods to play the video
        const playButton = document.querySelector('button[aria-label*="Play" i], .ytp-play-button, button.ytp-play-button');
        if (playButton) {
          const ariaLabel = playButton.getAttribute('aria-label') || '';
          if (ariaLabel.toLowerCase().includes('play')) {
            playButton.click();
            return true;
          }
        }
        
        // Try clicking on the video player itself
        const videoPlayer = document.querySelector('#movie_player, .html5-video-player');
        if (videoPlayer) {
          videoPlayer.click();
          return true;
        }
        
        // Try the video element
        const video = document.querySelector('video');
        if (video) {
          video.click();
          video.play().catch(() => {});
          return true;
        }
        
        return false;
      });
      
      if (videoPlaying) {
        console.log('✓ Video play initiated');
      } else {
        console.log('⚠ Could not find play button, video may auto-play');
      }
      
      const watchDuration = 20000 + Math.random() * 30000; // 20-50 seconds
      console.log(`⏱️  Watching video for ${Math.round(watchDuration / 1000)}s...`);
      
      await HumanEmulation.randomDelay(3000, 5000);
      
      // More realistic scrolling during video watch
      const scrollIntervals = Math.floor(watchDuration / 8000); // Scroll every ~8 seconds
      for (let i = 0; i < scrollIntervals && i < 5; i++) {
        if (page.isClosed()) break;
        
        // Scroll down
        await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 300));
        await HumanEmulation.randomDelay(3000, 5000);
        
        // Sometimes scroll back up a bit
        if (Math.random() < 0.5) {
          await page.evaluate(() => window.scrollBy(0, -100 - Math.random() * 100));
          await HumanEmulation.randomDelay(2000, 3000);
        }
        
        // Simulate reading/interacting
        await HumanEmulation.simulateReading(page, 2000 + Math.random() * 3000);
      }
      
      // Scroll to comments section
      console.log('Scrolling to comments section...');
      await page.evaluate(() => window.scrollBy(0, 600));
      await HumanEmulation.randomDelay(3000, 5000);
      await HumanEmulation.simulateReading(page, 4000 + Math.random() * 3000);
      
      // Scroll back up to video
      await page.evaluate(() => window.scrollBy(0, -300));
      await HumanEmulation.randomDelay(2000, 3000);
      
      console.log('✓ Finished watching YouTube video');
      
      try {
        const log = new InteractionLog({
          profileId,
          action: 'youtube_watch',
          url: page.url(),
          metadata: { query, videoTitle: videoToWatch.title },
          success: true
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save YouTube log:', logError);
      }
    } catch (error) {
      console.error('YouTube farming error:', error.message);
    } finally {
      // Ensure we're back on the original page
      if (!originalPage.isClosed()) {
        await originalPage.bringToFront();
        await HumanEmulation.randomDelay(1000, 2000);
      }
    }
  }

  async useGoogleSheets(page, profileId, browser = null) {
    const originalPage = page;
    const browserInstance = browser || page.browser();
    
    try {
      if (page.isClosed()) {
        console.log('Page closed, skipping Google Sheets');
        return;
      }
      
      await page.goto('https://sheets.google.com/?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
      await this.handlePopupsAndModals(page);
      await HumanEmulation.randomDelay(3000, 5000);
      
      // Wait for the page to fully load
      await page.waitForSelector('div[role="main"], div[data-view-type]', { timeout: 10000 }).catch(() => {});
      
      // Scroll a bit
      await page.evaluate(() => window.scrollBy(0, 200));
      await HumanEmulation.randomDelay(1500, 2500);
      
      if (page.isClosed()) return;
      
      // Find and click "Blank spreadsheet" to create new spreadsheet
      const originalPages = await browserInstance.pages();
      const originalPageCount = originalPages.length;
      
      console.log('Looking for Blank spreadsheet option...');
      
      const blankClicked = await page.evaluate(() => {
        // Method 1: Look for the "Blank spreadsheet" card in the "Start a new spreadsheet" section
        const allCards = Array.from(document.querySelectorAll('div[role="button"], div[data-tooltip], div[aria-label], button'));
        
        for (const card of allCards) {
          const ariaLabel = card.getAttribute('aria-label') || '';
          const tooltip = card.getAttribute('data-tooltip') || '';
          const title = card.getAttribute('title') || '';
          const text = (card.textContent || '').toLowerCase();
          const combined = (ariaLabel + ' ' + tooltip + ' ' + title + ' ' + text).toLowerCase();
          
          if (combined.includes('blank') && (combined.includes('spreadsheet') || combined.includes('sheet'))) {
            console.log('Found Blank spreadsheet card:', combined);
            card.click();
            return true;
          }
        }
        
        // Method 2: Look for cards with plus sign or "Blank" text
        const cardsWithPlus = Array.from(document.querySelectorAll('div[role="button"]'));
        for (const card of cardsWithPlus) {
          const text = (card.textContent || '').toLowerCase();
          if (text.includes('blank') && (text.includes('spreadsheet') || text.includes('sheet'))) {
            console.log('Found Blank spreadsheet by text:', text);
            card.click();
            return true;
          }
        }
        
        // Method 3: Click the first card in "Start a new spreadsheet" section (usually the blank one)
        const startSection = Array.from(document.querySelectorAll('div')).find(div => {
          const text = div.textContent || '';
          return text.includes('Start a new') && text.includes('spreadsheet');
        });
        
        if (startSection) {
          const firstCard = startSection.querySelector('div[role="button"]');
          if (firstCard) {
            console.log('Clicking first card in Start a new spreadsheet section');
            firstCard.click();
            return true;
          }
        }
        
        // Method 4: Try to find any clickable element with "Blank" in it
        const allClickable = Array.from(document.querySelectorAll('[role="button"], button, a'));
        for (const elem of allClickable) {
          const text = (elem.textContent || elem.getAttribute('aria-label') || '').toLowerCase();
          if (text.includes('blank') && (text.includes('spreadsheet') || text.includes('sheet'))) {
            console.log('Found Blank by searching all clickable elements:', text);
            elem.click();
            return true;
          }
        }
        
        console.log('Could not find Blank spreadsheet option');
        return false;
      });
      
      if (!blankClicked) {
        console.log('⚠ Could not find Blank spreadsheet option, trying alternative approach...');
        // Try waiting a bit more and retry
        await HumanEmulation.randomDelay(2000, 3000);
        
        const retryClicked = await page.evaluate(() => {
          // Try clicking on any element that looks like a blank template card
          const cards = Array.from(document.querySelectorAll('div[role="button"]'));
          if (cards.length > 0) {
            // Usually the first card is the blank one
            cards[0].click();
            return true;
          }
          return false;
        });
        
        if (!retryClicked) {
          console.log('⚠ Could not click Blank spreadsheet after retry');
          return;
        }
      }
      
      console.log('✓ Clicked Blank spreadsheet, waiting for new tab...');
      await HumanEmulation.randomDelay(3000, 5000);
      
      // Wait for new tab to open
      let sheetsPage = null;
      const maxWaitTime = 30000;
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWaitTime && !sheetsPage) {
        const currentPages = await browserInstance.pages();
        
        if (currentPages.length > originalPageCount) {
          const newPages = currentPages.slice(originalPageCount);
          for (const newPage of newPages) {
            try {
              const url = newPage.url();
              if (url.includes('docs.google.com/spreadsheets') || url.includes('sheets.google.com')) {
                sheetsPage = newPage;
                console.log(`✓ Found new Sheets tab: ${url}`);
                break;
              }
            } catch {}
          }
        }
        
        // Also check if current page navigated
        if (!sheetsPage && !page.isClosed()) {
          try {
            const currentUrl = page.url();
            if (currentUrl.includes('docs.google.com/spreadsheets') || currentUrl.includes('sheets.google.com')) {
              sheetsPage = page;
              console.log(`✓ Current page navigated to Sheets: ${currentUrl}`);
              break;
            }
          } catch {}
        }
        
        if (!sheetsPage) {
          await HumanEmulation.randomDelay(500, 1000);
        }
      }
      
      if (!sheetsPage) {
        console.log('⚠ New Sheets tab not detected, checking all pages...');
        const allPages = await browserInstance.pages();
        for (const checkPage of allPages) {
          try {
            const url = checkPage.url();
            if (url.includes('docs.google.com/spreadsheets')) {
              sheetsPage = checkPage;
              console.log(`✓ Found Sheets in existing page: ${url}`);
              break;
            }
          } catch {}
        }
      }
      
      if (!sheetsPage) {
        console.log('⚠ Could not find Sheets tab');
        return;
      }
      
      // Wait for Sheets to load
      await this.waitForNavigation(sheetsPage, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      await HumanEmulation.randomDelay(4000, 6000);
      
      // Scroll a bit
      await sheetsPage.evaluate(() => window.scrollBy(0, 200));
      await HumanEmulation.randomDelay(1500, 2500);
      
      // Enter test data in multiple cells
      console.log('📝 Entering test data in spreadsheet...');
      
      const testData = [
        ['Name', 'Age', 'City'],
        ['John Doe', '30', 'New York'],
        ['Jane Smith', '25', 'Los Angeles'],
        ['Bob Johnson', '35', 'Chicago']
      ];
      
      // Wait for the spreadsheet grid to be ready
      await sheetsPage.waitForSelector('[role="gridcell"], [role="grid"]', { timeout: 10000 }).catch(() => {});
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Click on cell A1 to start
      console.log('Clicking on cell A1...');
      const cellA1Clicked = await sheetsPage.evaluate(() => {
        // Try multiple methods to find and click cell A1
        const methods = [
          () => {
            // Method 1: Find by aria-label
            const cell = document.querySelector('[aria-label*="A1"], [aria-label*="Row 1, Column 1"]');
            if (cell) {
              cell.click();
              cell.focus();
              return true;
            }
            return false;
          },
          () => {
            // Method 2: Find first gridcell
            const gridCells = document.querySelectorAll('[role="gridcell"]');
            if (gridCells.length > 0) {
              gridCells[0].click();
              gridCells[0].focus();
              return true;
            }
            return false;
          },
          () => {
            // Method 3: Find by data attributes
            const cell = document.querySelector('[data-row="0"][data-col="0"], [data-row-index="0"][data-col-index="0"]');
            if (cell) {
              cell.click();
              cell.focus();
              return true;
            }
            return false;
          },
          () => {
            // Method 4: Click in the center of the visible grid area
            const grid = document.querySelector('[role="grid"]');
            if (grid) {
              const rect = grid.getBoundingClientRect();
              const clickX = rect.left + 50;
              const clickY = rect.top + 50;
              const element = document.elementFromPoint(clickX, clickY);
              if (element) {
                element.click();
                element.focus();
                return true;
              }
            }
            return false;
          }
        ];
        
        for (const method of methods) {
          if (method()) return true;
        }
        return false;
      });
      
      if (!cellA1Clicked) {
        console.log('⚠ Could not click cell A1, trying alternative approach...');
        // Try clicking anywhere in the grid
        await sheetsPage.mouse.click(200, 200);
        await HumanEmulation.randomDelay(1000, 2000);
      }
      
      // Enter data row by row
      for (let row = 0; row < testData.length; row++) {
        if (sheetsPage.isClosed()) break;
        
        console.log(`Entering row ${row + 1}: ${testData[row].join(', ')}`);
        
        for (let col = 0; col < testData[row].length; col++) {
          if (sheetsPage.isClosed()) break;
          
          const value = testData[row][col];
          
          // Type the value
          await HumanEmulation.randomDelay(300, 600);
          await sheetsPage.keyboard.type(value, { delay: 50 + Math.random() * 50 });
          await HumanEmulation.randomDelay(500, 1000);
          
          // Press Enter or Tab to move to next cell
          if (col < testData[row].length - 1) {
            await sheetsPage.keyboard.press('Tab');
            await HumanEmulation.randomDelay(500, 1000);
          } else {
            // Move to next row
            await sheetsPage.keyboard.press('Enter');
            await HumanEmulation.randomDelay(800, 1500);
            // Move to first column of next row
            if (row < testData.length - 1) {
              // Use Home key or arrow keys to go to first column
              await sheetsPage.keyboard.press('Home');
              await HumanEmulation.randomDelay(300, 600);
            }
          }
        }
      }
      
      console.log('✓ Test data entered in spreadsheet');
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Select all and copy (simulate user interaction)
      await sheetsPage.keyboard.down('Control');
      await sheetsPage.keyboard.press('a');
      await sheetsPage.keyboard.up('Control');
      await HumanEmulation.randomDelay(500, 1000);
      
      await sheetsPage.keyboard.down('Control');
      await sheetsPage.keyboard.press('c');
      await sheetsPage.keyboard.up('Control');
      await HumanEmulation.randomDelay(1000, 2000);
      
      console.log('✓ Copied data to clipboard');
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Scroll around
      await sheetsPage.evaluate(() => window.scrollBy(0, 300));
      await HumanEmulation.randomDelay(1500, 2500);
      await sheetsPage.evaluate(() => window.scrollBy(0, -150));
      await HumanEmulation.randomDelay(1000, 2000);
      
      try {
        const log = new InteractionLog({
          profileId,
          action: 'google_sheets',
          url: sheetsPage.url(),
          success: true
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save Google Sheets log:', logError);
      }
      
      // Close the Sheets tab and return to original
      if (sheetsPage !== originalPage && !sheetsPage.isClosed()) {
        await sheetsPage.bringToFront();
        await HumanEmulation.randomDelay(1000, 2000);
        await sheetsPage.close();
        console.log('✓ Closed Sheets tab');
      }
      
      if (!originalPage.isClosed()) {
        await originalPage.bringToFront();
        await HumanEmulation.randomDelay(1000, 2000);
        console.log('✓ Returned to original tab');
      }
    } catch (error) {
      console.error('Google Sheets error:', error.message);
    } finally {
      if (!originalPage.isClosed()) {
        await originalPage.bringToFront();
        await HumanEmulation.randomDelay(1000, 2000);
      }
    }
  }

  async useGoogleDocs(page, profileId, browser = null) {
    const originalPage = page;
    const browserInstance = browser || page.browser();
    
    try {
      if (page.isClosed()) {
        console.log('Page closed, skipping Google Docs');
        return;
      }
      
      console.log('📄 Starting Google Docs farming...');
      await page.goto('https://docs.google.com/?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
      await this.handlePopupsAndModals(page);
      await HumanEmulation.randomDelay(3000, 5000);
      
      await page.waitForSelector('div[role="main"], div[data-view-type]', { timeout: 10000 }).catch(() => {});
      await page.evaluate(() => window.scrollBy(0, 200));
      await HumanEmulation.randomDelay(1500, 2500);
      
      if (page.isClosed()) return;
      
      const originalPages = await browserInstance.pages();
      const originalPageCount = originalPages.length;
      
      console.log('Looking for Blank document option...');
      
      const blankClicked = await page.evaluate(() => {
        const allCards = Array.from(document.querySelectorAll('div[role="button"], div[data-tooltip], div[aria-label], button'));
        
        for (const card of allCards) {
          const ariaLabel = card.getAttribute('aria-label') || '';
          const tooltip = card.getAttribute('data-tooltip') || '';
          const title = card.getAttribute('title') || '';
          const text = (card.textContent || '').toLowerCase();
          const combined = (ariaLabel + ' ' + tooltip + ' ' + title + ' ' + text).toLowerCase();
          
          if (combined.includes('blank') && (combined.includes('document') || combined.includes('doc'))) {
            card.click();
            return true;
          }
        }
        
        const cardsWithPlus = Array.from(document.querySelectorAll('div[role="button"]'));
        for (const card of cardsWithPlus) {
          const text = (card.textContent || '').toLowerCase();
          if (text.includes('blank') && (text.includes('document') || text.includes('doc'))) {
            card.click();
            return true;
          }
        }
        
        const startSection = Array.from(document.querySelectorAll('div')).find(div => {
          const text = div.textContent || '';
          return text.includes('Start a new') && text.includes('document');
        });
        
        if (startSection) {
          const firstCard = startSection.querySelector('div[role="button"]');
          if (firstCard) {
            firstCard.click();
            return true;
          }
        }
        
        return false;
      });
      
      if (!blankClicked) {
        await HumanEmulation.randomDelay(2000, 3000);
        const retryClicked = await page.evaluate(() => {
          const cards = Array.from(document.querySelectorAll('div[role="button"]'));
          if (cards.length > 0) {
            cards[0].click();
            return true;
          }
          return false;
        });
        
        if (!retryClicked) {
          console.log('⚠ Could not click Blank document');
          return;
        }
      }
      
      console.log('✓ Clicked Blank document, waiting for new tab...');
      await HumanEmulation.randomDelay(3000, 5000);
      
      let docsPage = null;
      const maxWaitTime = 30000;
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWaitTime && !docsPage) {
        const currentPages = await browserInstance.pages();
        
        if (currentPages.length > originalPageCount) {
          const newPages = currentPages.slice(originalPageCount);
          for (const newPage of newPages) {
            try {
              const url = newPage.url();
              if (url.includes('docs.google.com/document')) {
                docsPage = newPage;
                console.log(`✓ Found new Docs tab: ${url}`);
                break;
              }
            } catch {}
          }
        }
        
        if (!docsPage && !page.isClosed()) {
          try {
            const currentUrl = page.url();
            if (currentUrl.includes('docs.google.com/document')) {
              docsPage = page;
              break;
            }
          } catch {}
        }
        
        if (!docsPage) {
          await HumanEmulation.randomDelay(500, 1000);
        }
      }
      
      if (!docsPage) {
        const allPages = await browserInstance.pages();
        for (const checkPage of allPages) {
          try {
            const url = checkPage.url();
            if (url.includes('docs.google.com/document')) {
              docsPage = checkPage;
              break;
            }
          } catch {}
        }
      }
      
      if (!docsPage) {
        console.log('⚠ Could not find Docs tab');
        return;
      }
      
      await this.waitForNavigation(docsPage, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      await HumanEmulation.randomDelay(4000, 6000);
      
      console.log('Waiting for Google Docs editor to load...');
      await docsPage.waitForSelector('[contenteditable="true"], .kix-appview-editor, [role="textbox"]', { timeout: 15000 }).catch(() => {});
      await HumanEmulation.randomDelay(2000, 3000);
      
      console.log('📝 Entering test data in document...');
      
      const testText = 'This is a test document created for automation purposes. It contains sample text to demonstrate proper functionality and ensure that the system works correctly when interacting with Google Docs. The document includes multiple sentences to simulate realistic user behavior and typing patterns.';
      
      const editorFocused = await docsPage.evaluate(() => {
        const editor = document.querySelector('[contenteditable="true"], .kix-appview-editor, [role="textbox"]');
        if (editor) {
          editor.click();
          editor.focus();
          return true;
        }
        return false;
      });
      
      if (!editorFocused) {
        await docsPage.mouse.click(400, 300);
        await HumanEmulation.randomDelay(1000, 2000);
      }
      
      await HumanEmulation.randomDelay(500, 1000);
      await docsPage.keyboard.type(testText, { delay: 50 + Math.random() * 50 });
      await HumanEmulation.randomDelay(2000, 3000);
      
      console.log('✓ Test data entered in document');
      
      await docsPage.keyboard.down('Control');
      await docsPage.keyboard.press('a');
      await docsPage.keyboard.up('Control');
      await HumanEmulation.randomDelay(500, 1000);
      
      await docsPage.keyboard.down('Control');
      await docsPage.keyboard.press('c');
      await docsPage.keyboard.up('Control');
      await HumanEmulation.randomDelay(1000, 2000);
      
      console.log('✓ Copied text to clipboard');
      await HumanEmulation.randomDelay(2000, 3000);
      
      try {
        const log = new InteractionLog({
          profileId,
          action: 'google_docs',
          url: docsPage.url(),
          success: true
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save Google Docs log:', logError);
      }
      
      if (docsPage !== originalPage && !docsPage.isClosed()) {
        await docsPage.bringToFront();
        await HumanEmulation.randomDelay(1000, 2000);
        await docsPage.close();
        console.log('✓ Closed Docs tab');
      }
      
      if (!originalPage.isClosed()) {
        await originalPage.bringToFront();
        await HumanEmulation.randomDelay(1000, 2000);
      }
    } catch (error) {
      console.error('Google Docs error:', error.message);
    } finally {
      if (!originalPage.isClosed()) {
        await originalPage.bringToFront();
        await HumanEmulation.randomDelay(1000, 2000);
      }
    }
  }

  async useGoogleNews(page, profileId) {
    console.log('📰 Starting Google News farming...');
    const originalPage = page;
    const browser = page.browser();
    
    try {
      if (page.isClosed()) {
        console.log('Page closed, skipping Google News');
        return;
      }
      
      console.log('Navigating to Google News...');
      await page.goto('https://news.google.com/?hl=en&gl=US&ceid=US:en', { waitUntil: 'networkidle2', timeout: 30000 });
      await this.handlePopupsAndModals(page);
      await HumanEmulation.randomDelay(3000, 5000);
      
      // Scroll through news feed to load more articles
      console.log('Scrolling through news feed...');
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.scrollBy(0, 400 + Math.random() * 300));
        await HumanEmulation.randomDelay(2000, 3000);
        await HumanEmulation.simulateReading(page, 2000 + Math.random() * 2000);
      }
      
      if (page.isClosed()) return;
      
      // Find article links - improved detection
      console.log('Looking for news articles...');
      let articleLinks = [];
      
      try {
        articleLinks = await page.evaluate(() => {
          // Try multiple selectors for article links
          const allLinks = Array.from(document.querySelectorAll('a[href]'));
          const articles = [];
          
          for (const link of allLinks) {
            try {
              const href = link.getAttribute('href');
              if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
              
              // Check if it's an article link
              const isArticle = href.includes('/articles/') || 
                               href.includes('/story/') ||
                               href.includes('news.google.com') ||
                               (link.closest('article') !== null) ||
                               (link.closest('[role="article"]') !== null);
              
              if (isArticle) {
                const text = link.textContent?.trim() || '';
                const title = link.getAttribute('title') || '';
                const ariaLabel = link.getAttribute('aria-label') || '';
                const articleText = text || title || ariaLabel;
                
                // Filter out navigation and non-content links
                if (articleText && articleText.length > 10 && 
                    !articleText.toLowerCase().includes('more') &&
                    !articleText.toLowerCase().includes('see all') &&
                    !articleText.toLowerCase().includes('show more')) {
                  articles.push({
                    href: href,
                    text: articleText.substring(0, 100),
                    element: link
                  });
                }
              }
            } catch (linkError) {
              // Skip this link if there's an error
              continue;
            }
          }
          
          return articles.slice(0, 10);
        });
      } catch (evaluateError) {
        console.log(`Error evaluating article links: ${evaluateError.message}`);
        articleLinks = [];
      }
      
      // Ensure articleLinks is an array
      if (!Array.isArray(articleLinks)) {
        console.log('⚠ articleLinks is not an array, defaulting to empty array');
        articleLinks = [];
      }
      
      console.log(`Found ${articleLinks.length} article(s)`);
      
      if (articleLinks.length > 0) {
        // Always click on at least one article (increased from 30% to 100%)
        const article = articleLinks[Math.floor(Math.random() * Math.min(3, articleLinks.length))];
        
        if (!article || !article.text) {
          console.log('⚠ Article object is invalid, skipping');
        } else {
          console.log(`📖 Reading news article: "${article.text.substring(0, 60)}..."`);
        
          const originalPages = await browser.pages();
          const originalPageCount = originalPages ? originalPages.length : 0;
          
          // Click on the article
          if (!article.href) {
            console.log('⚠ Article href is missing, skipping click');
          } else {
            const clicked = await page.evaluate((href) => {
              try {
                const links = Array.from(document.querySelectorAll('a[href]'));
                for (const link of links) {
                  const linkHref = link.getAttribute('href');
                  if (linkHref && (linkHref === href || linkHref.includes(href.split('?')[0]))) {
                    link.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    link.click();
                    return true;
                  }
                }
                return false;
              } catch (e) {
                return false;
              }
            }, article.href);
            
            if (!clicked) {
              console.log('⚠ Could not click article link, trying direct navigation...');
              try {
                const articleUrl = article.href.startsWith('http') ? article.href : `https://news.google.com${article.href}`;
                await page.goto(articleUrl, { waitUntil: 'networkidle2', timeout: 30000 });
              } catch (navError) {
                console.log(`Navigation error: ${navError.message}`);
              }
            }
            
            await HumanEmulation.randomDelay(3000, 5000);
            
            // Check if new tab opened
            let articlePage = null;
            try {
              const currentPages = await browser.pages();
              if (currentPages && currentPages.length > originalPageCount) {
                articlePage = currentPages[currentPages.length - 1];
                console.log('✓ Article opened in new tab');
              } else {
                await this.waitForNavigation(page, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                articlePage = page;
              }
            } catch (pageError) {
              console.log(`Error checking pages: ${pageError.message}`);
              articlePage = page;
            }
            
            if (articlePage && !articlePage.isClosed()) {
              await this.handlePopupsAndModals(articlePage);
              await HumanEmulation.randomDelay(3000, 5000);
              
              // Scroll through article
              console.log('Reading article content...');
              for (let i = 0; i < 5; i++) {
                if (articlePage.isClosed()) break;
                try {
                  await articlePage.evaluate(() => window.scrollBy(0, 300 + Math.random() * 400));
                  await HumanEmulation.randomDelay(2000, 4000);
                  await HumanEmulation.simulateReading(articlePage, 3000 + Math.random() * 3000);
                } catch (scrollError) {
                  console.log(`Scroll error: ${scrollError.message}`);
                  break;
                }
              }
              
              // Scroll back up a bit
              try {
                await articlePage.evaluate(() => window.scrollBy(0, -200));
                await HumanEmulation.randomDelay(1500, 2500);
              } catch (scrollError) {
                // Ignore scroll errors
              }
              
              // Close article tab if it's a new tab
              if (articlePage !== originalPage && !articlePage.isClosed()) {
                try {
                  await articlePage.close();
                  console.log('✓ Closed article tab');
                } catch (closeError) {
                  console.log(`Error closing tab: ${closeError.message}`);
                }
              } else if (articlePage === originalPage) {
                try {
                  await page.goBack({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                  await HumanEmulation.randomDelay(2000, 3000);
                } catch (backError) {
                  console.log(`Error going back: ${backError.message}`);
                }
              }
            }
          }
        }
      } else {
        console.log('⚠ No articles found, continuing with feed browsing...');
        // Continue scrolling even if no articles found
        await page.evaluate(() => window.scrollBy(0, 500));
        await HumanEmulation.randomDelay(2000, 3000);
        await HumanEmulation.simulateReading(page, 3000 + Math.random() * 2000);
      }
      
      try {
        const log = new InteractionLog({
          profileId,
          action: 'google_news',
          url: 'https://news.google.com',
          success: true
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save Google News log:', logError);
      }
    } catch (error) {
      console.error('Google News error:', error.message);
    } finally {
      if (!originalPage.isClosed()) {
        await originalPage.bringToFront();
        await HumanEmulation.randomDelay(1000, 2000);
      }
    }
  }

  async useGemini(page, profileId, searchQueries) {
    const originalPage = page;
    
    try {
      if (page.isClosed()) {
        console.log('Page closed, skipping Gemini');
        return;
      }
      
      if (!searchQueries || searchQueries.length === 0) {
        console.log('No search queries provided, skipping Gemini');
        return;
      }
      
      const query = searchQueries[Math.floor(Math.random() * searchQueries.length)];
      console.log(`Using Gemini with query: "${query}"`);
      
      await page.goto('https://gemini.google.com/?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
      await this.handlePopupsAndModals(page);
      await HumanEmulation.randomDelay(4000, 6000);
      
      if (page.isClosed()) return;
      
      // Step 1: Click "Chat with Gemini" button if on homepage
      console.log('Looking for "Chat with Gemini" button...');
      const chatButtonClicked = await page.evaluate(() => {
        // Look for "Chat with Gemini" button
        const buttons = Array.from(document.querySelectorAll('button, a[role="button"], div[role="button"]'));
        for (const btn of buttons) {
          const text = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
          if (text.includes('chat with gemini') || text.includes('chat') && text.includes('gemini')) {
            console.log('Found Chat with Gemini button');
            btn.click();
            return true;
          }
        }
        return false;
      });
      
      if (chatButtonClicked) {
        console.log('✓ Clicked "Chat with Gemini" button');
        await HumanEmulation.randomDelay(3000, 5000);
        // Wait for navigation or modal
        await this.waitForNavigation(page, { waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      }
      
      if (page.isClosed()) return;
      
      // Step 2: Handle "Welcome to Gemini" modal - click "Use Gemini"
      console.log('Checking for "Welcome to Gemini" modal...');
      const useGeminiClicked = await page.evaluate(() => {
        // Look for "Use Gemini" button in modal
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        for (const btn of buttons) {
          const text = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
          if (text.includes('use gemini') || (text.includes('use') && text.includes('gemini'))) {
            console.log('Found Use Gemini button');
            btn.click();
            return true;
          }
        }
        return false;
      });
      
      if (useGeminiClicked) {
        console.log('✓ Clicked "Use Gemini" button');
        await HumanEmulation.randomDelay(2000, 4000);
      }
      
      if (page.isClosed()) return;
      
      // Step 3: Click "No thanks" button if it exists
      console.log('Checking for "No thanks" button...');
      const noThanksClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        for (const btn of buttons) {
          const text = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
          if (text.includes('no thanks') || text === 'no thanks') {
            console.log('Found No thanks button');
            btn.click();
            return true;
          }
        }
        return false;
      });
      
      if (noThanksClicked) {
        console.log('✓ Clicked "No thanks" button');
        await HumanEmulation.randomDelay(2000, 3000);
      }
      
      if (page.isClosed()) return;
      
      // Step 4: Wait for chat screen to load
      await HumanEmulation.randomDelay(3000, 5000);
      
      // Step 5: Find input and enter question
      console.log('Looking for Gemini chat input...');
      
      // Wait a bit more for the chat interface to fully load
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Based on the actual HTML structure: div.ql-editor[contenteditable="true"] with aria-label="Enter a prompt here"
      const inputSelectors = [
        'div.ql-editor[contenteditable="true"][aria-label*="Enter a prompt"]',
        'div.ql-editor[contenteditable="true"]',
        '[contenteditable="true"][aria-label*="Enter a prompt"]',
        '[contenteditable="true"][aria-label*="prompt"]',
        '[contenteditable="true"][aria-label*="message"]',
        'div[contenteditable="true"].ql-editor',
        'div[contenteditable="true"]',
        'textarea[aria-label*="Enter a prompt"]',
        'textarea[placeholder*="Enter a prompt"]',
        'textarea[aria-label*="Type a message"]',
        'textarea[aria-label*="Message"]',
        'textarea',
        'input[type="text"]'
      ];
      
      let inputFound = false;
      let inputSelector = null;
      
      for (const selector of inputSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 8000, visible: true });
          const input = await page.$(selector);
          if (input) {
            const isVisible = await input.evaluate(el => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && 
                     style.display !== 'none' && 
                     style.visibility !== 'hidden' &&
                     el.offsetParent !== null;
            });
            
            if (isVisible) {
              inputSelector = selector;
              inputFound = true;
              console.log(`✓ Found Gemini input with selector: ${selector}`);
              break;
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      if (!inputFound) {
        console.log('⚠ Gemini input not found with selectors, trying alternative approach...');
        // Try to find contenteditable div (the actual Gemini input structure)
        const inputInfo = await page.evaluate(() => {
          // Try ql-editor first (Gemini's actual input)
          const qlEditor = document.querySelector('div.ql-editor[contenteditable="true"]');
          if (qlEditor) {
            const rect = qlEditor.getBoundingClientRect();
            const style = window.getComputedStyle(qlEditor);
            if (rect.width > 0 && rect.height > 0 && style.display !== 'none') {
              qlEditor.focus();
              qlEditor.click();
              return { found: true, type: 'contenteditable' };
            }
          }
          // Fallback to any contenteditable
          const contenteditables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
          for (const el of contenteditables) {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && el.offsetParent !== null) {
              el.focus();
              el.click();
              return { found: true, type: 'contenteditable' };
            }
          }
          // Last resort: textarea
          const textareas = Array.from(document.querySelectorAll('textarea'));
          for (const textarea of textareas) {
            const rect = textarea.getBoundingClientRect();
            const style = window.getComputedStyle(textarea);
            if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && textarea.offsetParent !== null) {
              textarea.focus();
              return { found: true, type: 'textarea' };
            }
          }
          return { found: false };
        });
        
        if (!inputInfo.found) {
          console.log('⚠ Could not find Gemini input - chat interface may not be loaded');
          return;
        }
        inputFound = true;
        inputSelector = inputInfo.type === 'contenteditable' ? '[contenteditable="true"]' : 'textarea';
      }
      
      // Type the question
      await HumanEmulation.randomDelay(1000, 2000);
      
      if (inputSelector && inputSelector.includes('contenteditable')) {
        // For contenteditable divs, click to focus and type directly
        try {
          await page.click(inputSelector);
          await HumanEmulation.randomDelay(500, 1000);
        } catch {}
        await page.evaluate((text) => {
          const input = document.querySelector('[contenteditable="true"]');
          if (input) {
            input.textContent = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, query);
        await HumanEmulation.randomDelay(1000, 2000);
      } else if (inputSelector) {
        await HumanEmulation.humanType(page, inputSelector, query);
        await HumanEmulation.randomDelay(1000, 2000);
      } else {
        // Fallback: type directly into focused element
        await page.keyboard.type(query, { delay: 100 });
        await HumanEmulation.randomDelay(1000, 2000);
      }
      
      console.log(`✓ Entered question: "${query}"`);
      
      // Step 6: Send the message
      const messageSent = await page.evaluate(() => {
        // Try to find and click send button
        const sendButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));
        for (const btn of sendButtons) {
          const text = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
          const isSend = text.includes('send') || text.includes('submit') || 
                        btn.getAttribute('type') === 'submit' ||
                        btn.querySelector('svg[aria-label*="send" i]');
          
          if (isSend && !btn.disabled) {
            const rect = btn.getBoundingClientRect();
            const style = window.getComputedStyle(btn);
            if (rect.width > 0 && rect.height > 0 && style.display !== 'none') {
              btn.click();
              return true;
            }
          }
        }
        
        // Fallback: try pressing Enter on contenteditable or textarea
        const contenteditable = document.querySelector('[contenteditable="true"]');
        if (contenteditable && document.activeElement === contenteditable) {
          const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
          contenteditable.dispatchEvent(event);
          return true;
        }
        
        const textarea = document.querySelector('textarea');
        if (textarea && document.activeElement === textarea) {
          const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
          textarea.dispatchEvent(event);
          return true;
        }
        
        return false;
      });
      
      if (messageSent) {
        console.log('✓ Sent message to Gemini');
      } else {
        console.log('⚠ Could not find send button, trying Enter key...');
        await page.keyboard.press('Enter');
      }
      
      console.log('✓ Sent message, waiting for Gemini response...');
      await HumanEmulation.randomDelay(6000, 12000);
      
      // Step 7: Scroll to see response
      await page.evaluate(() => window.scrollBy(0, 300));
      await HumanEmulation.randomDelay(2000, 3000);
      
      if (!page.isClosed()) {
        // Scroll through response
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollBy(0, 400 + Math.random() * 300));
          await HumanEmulation.randomDelay(3000, 5000);
          await HumanEmulation.simulateReading(page, 4000 + Math.random() * 4000);
        }
      }
      
      try {
        const log = new InteractionLog({
          profileId,
          action: 'gemini',
          url: 'https://gemini.google.com',
          metadata: { query },
          success: true
        });
        await log.save();
      } catch (logError) {
        console.error('Failed to save Gemini log:', logError);
      }
    } catch (error) {
      console.error('Gemini error:', error.message);
    } finally {
      if (!originalPage.isClosed()) {
        await originalPage.bringToFront();
        await HumanEmulation.randomDelay(1000, 2000);
      }
    }
  }

}