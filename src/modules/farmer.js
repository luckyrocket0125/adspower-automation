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

  async farmProfile(profileId) {
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
      browser = await this.adspower.connectBrowser(profileId);
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
      await this.useGoogleDrive(page, profileId, browser);
      await this.useGoogleMaps(page, profileId, profile.proxy);

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
      if (browser) {
        await browser.disconnect();
      }
    }
  }

  async browseGoogleSearch(page, profileId, searchQueries) {
    if (!searchQueries || searchQueries.length === 0) {
      console.log('No search queries provided, skipping Google Search browsing');
      return;
    }

    const queriesToUse = searchQueries.slice(0, 3);
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
        
        await page.goto('https://www.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
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
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        await HumanEmulation.randomDelay(2000, 4000);
        
        if (page.isClosed()) {
          console.log('Page closed after search');
          break;
        }
        
        await HumanEmulation.simulateReading(page, 2000);
        
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
            
            if (results.length >= 3) break;
          }
          
          return results;
        });
        
        if (searchResults.length === 0) {
          console.log('No search results found, skipping');
          continue;
        }
        
        console.log(`Found ${searchResults.length} search result(s)`);
        
        for (const result of searchResults.slice(0, 2)) {
          if (page.isClosed()) {
            console.log('Page closed, skipping remaining results');
            break;
          }
          
          try {
            console.log(`Clicking on search result: ${result.text.substring(0, 50)}...`);
            
            const clicked = await page.evaluate((url) => {
              const links = Array.from(document.querySelectorAll('a[href]'));
              for (const link of links) {
                let href = link.getAttribute('href');
                if (href.startsWith('/url?q=')) {
                  const match = href.match(/\/url\?q=([^&]+)/);
                  if (match) href = decodeURIComponent(match[1]);
                }
                if (href === url || href.includes(url.split('/')[2])) {
                  link.click();
                  return true;
                }
              }
              return false;
            }, result.url);
            
            if (!clicked) {
              console.log(`Could not find link for ${result.url}, trying direct navigation`);
              await page.goto(result.url, { waitUntil: 'networkidle2', timeout: 30000 });
            } else {
              await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
            }
            
            await HumanEmulation.randomDelay(3000, 5000);
            
            if (!page.isClosed()) {
              await HumanEmulation.simulateReading(page, 5000 + Math.random() * 5000);
              await HumanEmulation.readingJitter(page);
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
            console.log(`Failed to navigate to ${result.url}:`, navError.message);
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
    try {
      // Check if page is still valid
      if (page.isClosed()) {
        console.log('Page closed, skipping Google Drive');
        return;
      }
      
      await page.goto('https://drive.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
      
      // Check again after navigation
      if (page.isClosed()) {
        console.log('Page closed after navigation to Google Drive');
        return;
      }
      
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
                docsPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
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
                await page.goto('https://drive.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
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
        console.log('New/Create button not found on Google Drive');
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
      console.error('Google Drive error:', error);
      
      // Handle frame detachment errors gracefully
      if (error.message.includes('detached') || 
          error.message.includes('Requesting main frame too early') ||
          error.message.includes('not clickable') ||
          error.message.includes('not an Element')) {
        console.log('Page/frame detached or element not clickable during Google Drive operation, skipping');
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
    try {
      // Check if page is still valid
      if (page.isClosed()) {
        console.log('Page closed, skipping Google Maps');
        return;
      }
      
      await page.goto('https://maps.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
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
      await HumanEmulation.randomDelay(3000, 5000);

        if (page.isClosed()) {
          console.log('Page closed after Google Maps search');
          return;
        }

        const directionsButton = await page.$('button[aria-label*="Directions"], button[data-value="Directions"]');
        if (directionsButton) {
          try {
            // Check if button is visible
            const isVisible = await page.evaluate((el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            }, directionsButton);
            
            if (!isVisible) {
              console.log('Directions button not visible, skipping');
              return;
            }
            
            await HumanEmulation.moveMouse(page, 100, 100, 200, 200);
            await directionsButton.scrollIntoView();
            await HumanEmulation.randomDelay(200, 500);
            await directionsButton.click();
            await HumanEmulation.randomDelay(2000, 3000);
          } catch (dirClickError) {
            if (dirClickError.message.includes('detached') || dirClickError.message.includes('not clickable') || dirClickError.message.includes('not an Element')) {
              console.log('Directions button not clickable, skipping');
              return;
            }
            throw dirClickError;
          }
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
}
