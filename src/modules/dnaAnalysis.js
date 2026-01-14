import { AdsPowerService } from '../services/adspower.js';
import { analyzePersonaFromEmails } from '../services/openai.js';
import { Profile } from '../models/Profile.js';
import { InteractionLog } from '../models/InteractionLog.js';
import { HumanEmulation } from '../utils/humanEmulation.js';
import { SMSPoolService } from '../services/smspool.js';

export class DNAAnalysis {
  constructor() {
    this.adspower = new AdsPowerService();
    this.smspool = new SMSPoolService();
  }

  async analyzeProfile(profileId) {
    const profile = await Profile.findById(profileId);
    if (!profile) {
      throw new Error(`Profile ${profileId} not found`);
    }

    let browser;
    let page;

    try {
      browser = await this.adspower.connectBrowser(profileId);
      page = (await browser.pages())[0] || await browser.newPage();

      // Check if page is valid before navigation
      if (page.isClosed()) {
        throw new Error('Browser page was closed');
      }

      try {
        await page.goto('https://gmail.com', { waitUntil: 'networkidle2', timeout: 30000 });
        await HumanEmulation.randomDelay(2000, 4000);
      } catch (navError) {
        if (navError.message.includes('detached') || navError.message.includes('closed') || navError.message.includes('Target closed')) {
          console.log('Page was detached/closed during navigation, retrying...');
          page = (await browser.pages())[0] || await browser.newPage();
          await page.goto('https://gmail.com', { waitUntil: 'networkidle2', timeout: 30000 });
          await HumanEmulation.randomDelay(2000, 4000);
        } else {
          throw navError;
        }
      }

      // Check again before scraping
      if (page.isClosed()) {
        throw new Error('Browser page was closed before scraping');
      }

      const emailData = await this.scrapeGmail(page, profile);
      const persona = await analyzePersonaFromEmails(emailData);

      await Profile.updatePersona(profileId, persona);
      await this.adspower.updateProfileNotes(profileId, 
        `${persona.gender} | ${persona.ageBracket} | ${persona.interests.join(', ')}`
      );

      const log = new InteractionLog({
        profileId,
        action: 'dna_analysis',
        url: 'https://gmail.com',
        success: true,
        metadata: { persona }
      });
      await log.save();

      return persona;
    } catch (error) {
      console.error(`DNA Analysis error for profile ${profileId}:`, error);
      
      // Handle frame detachment errors gracefully
      if (error.message.includes('detached') || error.message.includes('closed') || error.message.includes('Target closed') || error.message.includes('Navigating frame was detached')) {
        console.log('Frame detachment detected, this is usually harmless - browser may have been closed or navigated');
        // Don't throw - return fallback data instead
        try {
          const log = new InteractionLog({
            profileId,
            action: 'dna_analysis',
            url: 'https://gmail.com',
            success: false,
            error: 'Frame detached - browser closed or navigated'
          });
          await log.save();
        } catch (logError) {
          console.error('Failed to save error log:', logError);
        }
        // Return empty persona data instead of crashing
        return {
          gender: 'unknown',
          ageBracket: 'unknown',
          interests: []
        };
      }
      
      try {
        const log = new InteractionLog({
          profileId,
          action: 'dna_analysis',
          url: 'https://gmail.com',
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

  async scrapeGmail(page, profile) {
    try {
      // Check if page is still valid
      if (page.isClosed()) {
        console.log('Page closed, cannot scrape Gmail');
        return await this.getFallbackData(page);
      }

      // Navigate to Gmail inbox directly
      try {
        await page.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'networkidle2', timeout: 30000 });
        await HumanEmulation.randomDelay(3000, 5000);
      } catch (navError) {
        if (navError.message.includes('detached') || navError.message.includes('closed') || navError.message.includes('Target closed')) {
          console.log('Page was detached during Gmail navigation');
          return await this.getFallbackData(page);
        }
        throw navError;
      }
      
      // Check if page is still valid
      if (page.isClosed()) {
        console.log('Page closed, using fallback data');
        return await this.getFallbackData(page);
      }

      // Check current URL and page state
      let currentUrl;
      try {
        currentUrl = page.url();
        console.log(`Current Gmail URL: ${currentUrl}`);
      } catch (urlError) {
        if (urlError.message.includes('detached') || urlError.message.includes('closed')) {
          console.log('Page detached while getting URL');
          return await this.getFallbackData(page);
        }
        throw urlError;
      }
      
      // First, check if we're already logged in by looking for Gmail interface elements
      // IMPORTANT: Check URL first to avoid false positives from sign-in page
      let isLoggedIn = false;
      
      // Check URL first - if we're on accounts.google.com, we're definitely not logged in
      if (currentUrl.includes('accounts.google.com') && (currentUrl.includes('signin') || currentUrl.includes('identifier'))) {
        console.log('On Google sign-in page, definitely not logged in');
        isLoggedIn = false;
      } else {
        // Only check for Gmail elements if we're not on sign-in page
        try {
          isLoggedIn = await page.evaluate(() => {
            // Check URL in page context
            const url = window.location.href;
            if (url.includes('accounts.google.com') && (url.includes('signin') || url.includes('identifier'))) {
              return false; // Definitely on sign-in page
            }
            
            // Check for Gmail-specific elements that indicate we're logged in
            const gmailIndicators = [
              Array.from(document.querySelectorAll('[aria-label], [data-tooltip]')).find(el => {
                const label = (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').toLowerCase();
                return label.includes('inbox') && !label.includes('sign in');
              }),
              document.querySelector('a[href*="#inbox"]'),
              document.querySelector('table[role="grid"] tbody tr[role="row"]'), // Actual email rows
              document.querySelector('div[role="main"] table') // Email table
            ].filter(Boolean);
            
            // Also verify we're on mail.google.com
            const isOnGmailDomain = url.includes('mail.google.com') || url.includes('workspace.google.com');
            
            return gmailIndicators.length > 0 && isOnGmailDomain;
          });
        } catch (evalError) {
          if (evalError.message.includes('detached') || evalError.message.includes('closed') || evalError.message.includes('Target closed')) {
            console.log('Page detached during login check evaluation');
            return await this.getFallbackData(page);
          }
          throw evalError;
        }
      }
      
      console.log(`Login status check: isLoggedIn=${isLoggedIn}, currentUrl=${currentUrl}`);
      
      // Check if we need to login - only if not already logged in
      if (!isLoggedIn) {
        console.log('Not logged in, checking for login page...');
        
        let pageState;
        try {
          pageState = await page.evaluate(() => {
            return {
              hasEmailInput: !!document.querySelector('input[type="email"], input[name="identifier"]'),
              hasSignInButton: Array.from(document.querySelectorAll('button, a')).some(btn => 
                btn.textContent.toLowerCase().includes('sign in')
              ),
              url: window.location.href,
              title: document.title
            };
          });
        } catch (evalError) {
          if (evalError.message.includes('detached') || evalError.message.includes('closed') || evalError.message.includes('Target closed')) {
            console.log('Page detached during page state evaluation');
            return await this.getFallbackData(page);
          }
          throw evalError;
        }
        
        console.log('Page state:', pageState);
        
        // Get the actual current URL from page state (more reliable than cached currentUrl)
        const actualUrl = pageState.url || currentUrl;
        console.log(`Actual URL from page: ${actualUrl}`);
        
        // Check if we're on Gmail domain (check the domain, not query params)
        // The URL might have mail.google.com in query params, so check the actual domain
        const urlObj = new URL(actualUrl);
        const isOnGmailDomain = urlObj.hostname.includes('mail.google.com') || urlObj.hostname.includes('workspace.google.com');
        const isOnAccountsDomain = urlObj.hostname.includes('accounts.google.com');
        
        console.log(`URL check: hostname=${urlObj.hostname}, isOnGmailDomain=${isOnGmailDomain}, isOnAccountsDomain=${isOnAccountsDomain}`);
        
        // If we're on Gmail but not logged in, navigate to sign-in page
        if (isOnGmailDomain && !isOnAccountsDomain) {
          if (!pageState.hasEmailInput) {
            console.log('On Gmail but not logged in, navigating to sign-in page...');
            try {
              await page.goto('https://accounts.google.com/signin/v2/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&service=mail&flowName=GlifWebSignIn&flowEntry=ServiceLogin', {
                waitUntil: 'networkidle2',
                timeout: 30000
              });
              await HumanEmulation.randomDelay(2000, 3000);
            } catch (navError) {
              if (navError.message.includes('detached') || navError.message.includes('closed') || navError.message.includes('Target closed')) {
                console.log('Page detached during sign-in navigation');
                return await this.getFallbackData(page);
              }
              throw navError;
            }
            
            // Check if page is still valid
            if (page.isClosed()) {
              console.log('Page closed after navigation');
              return await this.getFallbackData(page);
            }

            // Re-check page state after navigation
            let newUrl;
            try {
              newUrl = page.url();
              console.log(`After navigation, URL is: ${newUrl}`);
            } catch (urlError) {
              if (urlError.message.includes('detached') || urlError.message.includes('closed')) {
                console.log('Page detached while getting URL after navigation');
                return await this.getFallbackData(page);
              }
              throw urlError;
            }
            
            // Now check if login is needed (after navigation)
            let newPageState;
            try {
              newPageState = await page.evaluate(() => {
                return {
                  hasEmailInput: !!document.querySelector('input[type="email"], input[name="identifier"]'),
                  hasSignInButton: Array.from(document.querySelectorAll('button, a')).some(btn => 
                    btn.textContent.toLowerCase().includes('sign in')
                  )
                };
              });
            } catch (evalError) {
              if (evalError.message.includes('detached') || evalError.message.includes('closed') || evalError.message.includes('Target closed')) {
                console.log('Page detached during page state evaluation after navigation');
                return await this.getFallbackData(page);
              }
              throw evalError;
            }
            
            console.log('Page state after navigation:', newPageState);
            
            if (newPageState.hasEmailInput || newUrl.includes('accounts.google.com/signin')) {
              console.log('Login required, attempting to login...');
              if (profile.email && profile.password) {
                await this.handleLogin(page, profile);
                // Wait for redirect back to Gmail
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                await HumanEmulation.randomDelay(3000, 5000);
              } else {
                console.log('No email/password provided, cannot login');
                return await this.getFallbackData(page);
              }
            }
          }
        } else {
          // Not on Gmail domain, check if already on sign-in page
          // Use actual URL from page state
          const actualUrl = pageState.url || currentUrl;
          const urlObj = new URL(actualUrl);
          const isOnAccountsDomain = urlObj.hostname.includes('accounts.google.com');
          const hasSignInInPath = actualUrl.includes('/signin') || actualUrl.includes('/v3/signin') || actualUrl.includes('identifier');
          
          // Check for various Google sign-in URL patterns
          const isOnSignInPage = pageState.hasEmailInput || 
                                 (isOnAccountsDomain && hasSignInInPath);
          
          console.log(`Login check: isOnSignInPage=${isOnSignInPage}`);
          console.log(`  - hasEmailInput: ${pageState.hasEmailInput}`);
          console.log(`  - isOnAccountsDomain: ${isOnAccountsDomain}`);
          console.log(`  - hasSignInInPath: ${hasSignInInPath}`);
          console.log(`  - actualUrl: ${actualUrl}`);
          
          if (isOnSignInPage) {
            console.log('✓ CONFIRMED: On sign-in page, proceeding with login...');
            console.log('✓ Login required, attempting to login...');
            if (profile.email && profile.password) {
              console.log(`✓ Profile has email: ${profile.email.substring(0, 5)}... and password`);
              try {
                console.log('>>> CALLING handleLogin NOW <<<');
                await this.handleLogin(page, profile);
                console.log('>>> handleLogin COMPLETED <<<');
                
                // Wait for redirect back to Gmail
                console.log('Waiting for navigation after login...');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch((navErr) => {
                  console.log('Navigation wait completed or timed out:', navErr.message);
                });
                await HumanEmulation.randomDelay(5000, 8000); // Longer wait after login
                
                // Re-check if we're now on Gmail
                const finalUrl = page.url();
                console.log(`After login, final URL: ${finalUrl}`);
                
                if (!finalUrl.includes('mail.google.com') && !finalUrl.includes('workspace.google.com')) {
                  console.log('⚠ Still not on Gmail after login, may need additional verification');
                } else {
                  console.log('✓ Successfully navigated to Gmail after login');
                }
              } catch (loginError) {
                console.error('✗ ERROR during handleLogin:', loginError.message);
                console.error('Stack:', loginError.stack);
                throw loginError; // Re-throw to prevent continuing with failed login
              }
            } else {
              console.log('✗ No email/password provided, cannot login');
              console.log(`  Email: ${profile.email ? 'present' : 'missing'}, Password: ${profile.password ? 'present' : 'missing'}`);
              return await this.getFallbackData(page);
            }
          } else {
            console.log('✗ Not on sign-in page and not logged in, using fallback data');
            console.log(`  URL: ${currentUrl}`);
            console.log(`  hasEmailInput: ${pageState.hasEmailInput}`);
            return await this.getFallbackData(page);
          }
        }
      } else {
        console.log('Already logged in to Gmail');
      }
      
      // Re-check URL after login attempt - it may have changed
      let finalUrl;
      try {
        finalUrl = page.url();
        console.log(`Current URL after login check: ${finalUrl}`);
      } catch (urlError) {
        if (urlError.message.includes('detached') || urlError.message.includes('closed')) {
          console.log('Page detached while getting final URL');
          return await this.getFallbackData(page);
        }
        throw urlError;
      }
      
      // Check if we're actually logged in - verify we're on Gmail, not sign-in page
      const isActuallyOnGmail = finalUrl.includes('mail.google.com') || finalUrl.includes('workspace.google.com');
      const isStillOnSignIn = finalUrl.includes('accounts.google.com') && (finalUrl.includes('signin') || finalUrl.includes('identifier'));
      
      if (isStillOnSignIn && !isActuallyOnGmail) {
        console.log('Still on sign-in page after login attempt - login may have failed or needs manual intervention');
        console.log('URL:', finalUrl);
        return await this.getFallbackData(page);
      }
      
      if (!isActuallyOnGmail) {
        console.log('Not on Gmail after login, using fallback data');
        return await this.getFallbackData(page);
      }
      
      // Check if we're logged in - look for Gmail interface elements
      let hasInboxElement;
      try {
        hasInboxElement = await page.evaluate(() => {
          const elements = Array.from(document.querySelectorAll('[aria-label], [data-tooltip]'));
          return elements.some(el => {
            const label = (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').toLowerCase();
            return label.includes('inbox');
          });
        });
      } catch (evalError) {
        if (evalError.message.includes('detached') || evalError.message.includes('closed')) {
          console.log('Page detached during inbox check');
          return await this.getFallbackData(page);
        }
        throw evalError;
      }
      
      const loggedInIndicators = [
        hasInboxElement,
        await page.$('a[href*="#inbox"]'),
        await page.$('[role="navigation"]'),
        isActuallyOnGmail
      ];
      
      if (!loggedInIndicators.some(Boolean)) {
        console.log('Not logged in to Gmail (no inbox elements found), using fallback data');
        return await this.getFallbackData(page);
      }
      
      console.log('Verified: Actually logged in to Gmail');
      
      // Double-check we're actually on Gmail inbox, not sign-in page
      const urlCheck = page.url();
      if (urlCheck.includes('accounts.google.com') && (urlCheck.includes('signin') || urlCheck.includes('identifier'))) {
        console.log('Still on sign-in page, login may not have completed');
        console.log('Current URL:', urlCheck);
        return await this.getFallbackData(page);
      }
      
      // Navigate to inbox if not already there
      if (!urlCheck.includes('#inbox') && !urlCheck.includes('view')) {
        console.log('Navigating to Gmail inbox...');
        try {
          await page.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'networkidle2', timeout: 30000 });
          await HumanEmulation.randomDelay(3000, 5000);
        } catch (navError) {
          if (navError.message.includes('detached') || navError.message.includes('closed')) {
            console.log('Page detached during inbox navigation');
            return await this.getFallbackData(page);
          }
          throw navError;
        }
      }
      
      // Wait for Gmail interface to be ready - give it more time after login
      try {
        // Wait a bit longer for Gmail to fully load after login
        await HumanEmulation.randomDelay(3000, 5000);
        
        // Try multiple selectors with longer timeout - but verify they're actually Gmail inbox elements
        const selectors = [
          'div[role="main"]',
          'div[data-view-type="1"]',
          'table[role="grid"]',
          'div[role="tabpanel"]' // Gmail inbox tab
        ];
        
        let found = false;
        for (const selector of selectors) {
          try {
            await page.waitForSelector(selector, { timeout: 10000 });
            // Verify this is actually Gmail inbox, not sign-in page
            const isGmailInbox = await page.evaluate((sel) => {
              const element = document.querySelector(sel);
              if (!element) return false;
              // Check if it contains inbox-related content
              const text = element.textContent.toLowerCase();
              const hasInboxContent = text.includes('inbox') || 
                                     text.includes('compose') || 
                                     text.includes('search mail') ||
                                     element.querySelector('tr[role="row"]') !== null;
              return hasInboxContent;
            }, selector);
            
            if (isGmailInbox) {
              found = true;
              console.log(`Found Gmail inbox interface using selector: ${selector}`);
              break;
            }
          } catch (e) {
            continue;
          }
        }
        
        // Also check for inbox element
        if (!found) {
          const hasInbox = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('[aria-label], [data-tooltip]'));
            return elements.some(el => {
              const label = (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').toLowerCase();
              return label.includes('inbox') && !label.includes('sign in');
            });
          });
          if (hasInbox) {
            found = true;
            console.log('Found Gmail interface by inbox element');
          }
        }
        
        if (!found) {
          console.log('Gmail inbox interface not found, but continuing anyway...');
        } else {
          console.log('Gmail inbox interface loaded');
        }
        
        // Wait a bit more for email list to populate
        await HumanEmulation.randomDelay(2000, 4000);
      } catch (waitError) {
        console.log('Gmail main area not found, checking page state...');
        
        // Check what's actually on the page
        const pageContent = await page.evaluate(() => {
          return {
            title: document.title,
            hasInbox: !!Array.from(document.querySelectorAll('[aria-label]')).find(el => 
              el.getAttribute('aria-label')?.toLowerCase().includes('inbox')
            ),
            hasEmailInput: !!document.querySelector('input[type="email"]'),
            url: window.location.href,
            bodyText: document.body.textContent.substring(0, 200)
          };
        });
        console.log('Page state:', pageContent);
        
        // If we're still on login page, try navigating again
        if (pageContent.hasEmailInput || currentUrl.includes('accounts.google.com')) {
          console.log('Still on login page, cannot proceed');
          return await this.getFallbackData(page);
        }
      }

      // Check if inbox is empty or has emails
      const inboxState = await page.evaluate(() => {
        // Check for empty inbox message by searching text content
        const bodyText = document.body.textContent.toLowerCase();
        const hasEmptyMessage = /no.*mail/i.test(bodyText) || /inbox.*empty/i.test(bodyText);
        
        // Check for empty indicators in attributes
        const emptyIndicators = Array.from(document.querySelectorAll('[data-tooltip], [aria-label]'))
          .filter(el => {
            const text = (el.getAttribute('data-tooltip') || el.getAttribute('aria-label') || '').toLowerCase();
            return text.includes('empty');
          });
        
        const isEmpty = hasEmptyMessage || emptyIndicators.length > 0;
        
        return {
          isEmpty: emptyIndicators.length > 0,
          hasEmailRows: document.querySelectorAll('tr[role="row"]').length > 0,
          hasEmailTable: !!document.querySelector('table[role="grid"]'),
          emailCount: document.querySelectorAll('tr[role="row"]').length
        };
      });
      
      console.log('Inbox state:', inboxState);
      
      if (inboxState.isEmpty && inboxState.emailCount === 0) {
        console.log('Inbox is empty, using fallback data');
        return await this.getFallbackData(page);
      }
      
      // Try multiple selectors for email list - wait longer and try more times
      const emailSelectors = [
        'tr[role="row"]',  // Most common Gmail selector
        'div[role="main"] tr',
        'table[role="grid"] tbody tr',
        'div[data-view-type="1"] tr',
        'div[jscontroller] tr[role="row"]',
        'tbody tr',  // Fallback
        'div[role="main"] > div > div > div tr', // Nested structure
        '[data-thread-id]', // Email thread IDs
        '[data-thread-perm-id]' // Email thread perm IDs
      ];
      
      let emailSelector = null;
      // Try multiple times with delays in case emails are still loading
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          console.log(`Retry ${attempt + 1}/3: Waiting for emails to load...`);
          await HumanEmulation.randomDelay(3000, 5000);
        }
        
        for (const selector of emailSelectors) {
          try {
            const element = await page.waitForSelector(selector, { timeout: 10000 });
            if (element) {
              // Verify it's actually an email row (not header or empty)
              const count = await page.evaluate((sel) => {
                const rows = document.querySelectorAll(sel);
                return Array.from(rows).filter(row => {
                  const text = row.textContent.trim();
                  // More lenient filtering - just check it's not navigation/header
                  return text.length > 5 && 
                         !text.includes('Inbox') && 
                         !text.includes('Compose') &&
                         !text.includes('Search') &&
                         !text.includes('Settings');
                }).length;
              }, selector);
              
              if (count > 0) {
                emailSelector = selector;
                console.log(`Found email list using selector: ${selector} (${count} emails)`);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        if (emailSelector) break;
      }
      
      if (!emailSelector) {
        console.log('No email list selector found, using fallback data');
        return await this.getFallbackData(page);
      }

      const emails = await page.evaluate((selector) => {
        const emailElements = document.querySelectorAll(selector);
        const emailData = [];
        
        for (let i = 0; i < Math.min(40, emailElements.length); i++) {
          const row = emailElements[i];
          
          // Try multiple possible selectors for email data
          const subject = row.querySelector('.bog')?.textContent?.trim() || 
                         row.querySelector('[data-thread-perm-id]')?.getAttribute('data-thread-perm-id')?.split('/').pop() ||
                         row.querySelector('span[email]')?.textContent?.trim() ||
                         row.querySelector('.bqe')?.textContent?.trim() ||
                         '';
          
          const snippet = row.querySelector('.y2')?.textContent?.trim() || 
                         row.querySelector('.bog')?.textContent?.trim() ||
                         row.querySelector('[data-thread-id]')?.textContent?.trim() ||
                         '';
          
          const sender = row.querySelector('.yW span')?.textContent?.trim() || 
                        row.querySelector('[email]')?.textContent?.trim() ||
                        row.querySelector('.yW')?.textContent?.trim() ||
                        '';
          
          if (subject || snippet || sender || row.textContent.trim().length > 10) {
            emailData.push({
              subject: subject || '',
              snippet: snippet || '',
              sender: sender || '',
              rawText: row.textContent.trim().substring(0, 200) // Fallback: first 200 chars
            });
          }
        }
        
        return emailData;
      }, emailSelector);

      if (emails.length === 0) {
        const fallbackData = await this.getFallbackData(page);
        return fallbackData;
      }

      return emails;
    } catch (error) {
      console.error('Gmail scraping error:', error);
      return await this.getFallbackData(page);
    }
  }

  async getFallbackData(page) {
    try {
      const emailAddress = await page.evaluate(() => {
        return document.querySelector('a[aria-label*="@"]')?.textContent || '';
      });

      const name = await page.evaluate(() => {
        return document.querySelector('span[data-name]')?.getAttribute('data-name') || '';
      });

      return [{
        email: emailAddress,
        name: name,
        note: 'Limited data available'
      }];
    } catch (error) {
      return [{ note: 'No email data could be extracted' }];
    }
  }

  async handleLogin(page, profile) {
    console.log('=== handleLogin STARTED ===');
    console.log(`Profile email: ${profile.email ? profile.email.substring(0, 10) + '...' : 'MISSING'}`);
    console.log(`Profile password: ${profile.password ? '***' : 'MISSING'}`);
    
    try {
      if (!profile.email || !profile.password) {
        throw new Error('Email and password are required for login');
      }

      console.log('Attempting to login to Gmail...');
      
      // Debug: Check what's on the page
      const pageInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        return {
          url: window.location.href,
          title: document.title,
          inputCount: inputs.length,
          inputTypes: inputs.map(inp => ({
            type: inp.type,
            name: inp.name,
            id: inp.id,
            ariaLabel: inp.getAttribute('aria-label'),
            placeholder: inp.placeholder
          }))
        };
      });
      console.log('Page info before login:', JSON.stringify(pageInfo, null, 2));
      
      // Wait for email input to be available - try multiple selectors
      const emailSelectors = [
        'input[type="email"]',
        'input[name="identifier"]',
        'input[id*="identifier"]',
        'input[id*="Email"]',
        'input[autocomplete="username"]'
      ];
      
      let emailInput = null;
      
      for (const selector of emailSelectors) {
        try {
          emailInput = await page.waitForSelector(selector, { timeout: 15000 });
          if (emailInput) {
            console.log(`Found email input using selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      // If not found by standard selectors, try finding by aria-label or other attributes
      if (!emailInput) {
        console.log('Trying to find email input by evaluating page...');
        const foundInput = await page.evaluateHandle(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          return inputs.find(input => {
            const type = input.type.toLowerCase();
            const name = (input.name || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            const label = (input.getAttribute('aria-label') || '').toLowerCase();
            const placeholder = (input.placeholder || '').toLowerCase();
            const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
            
            return type === 'email' ||
                   name.includes('identifier') || name.includes('email') ||
                   id.includes('identifier') || id.includes('email') ||
                   label.includes('email') || label.includes('identifier') ||
                   placeholder.includes('email') ||
                   autocomplete === 'username' || autocomplete.includes('email');
          });
        });
        
        if (foundInput && foundInput.asElement()) {
          emailInput = foundInput.asElement();
          console.log('Found email input using evaluate');
        }
      }
      
      if (!emailInput) {
        // Take a screenshot for debugging
        try {
          await page.screenshot({ path: 'gmail-login-debug.png' });
          console.log('Screenshot saved as gmail-login-debug.png');
        } catch (e) {
          console.log('Could not take screenshot:', e.message);
        }
        throw new Error(`Email input field not found. Page has ${pageInfo.inputCount} input fields. Check gmail-login-debug.png for details.`);
      }
      
      // Type email using the element directly
      try {
        // Focus the input first
        await emailInput.focus();
        await HumanEmulation.randomDelay(200, 500);
        
        // Clear any existing text
        await emailInput.click({ clickCount: 3 }); // Triple click to select all
        await page.keyboard.press('Backspace');
        await HumanEmulation.randomDelay(100, 200);
        
        console.log(`>>> About to type email: ${profile.email} <<<`);
        const emailToType = profile.email;
        console.log(`Email length: ${emailToType.length} characters`);
        
        // Try typing character by character for better debugging
        for (let i = 0; i < emailToType.length; i++) {
          const char = emailToType[i];
          await emailInput.type(char, { delay: 50 + Math.random() * 50 });
          if (i % 10 === 0 || i === emailToType.length - 1) {
            console.log(`Typed ${i + 1}/${emailToType.length} characters...`);
          }
        }
        console.log('✓ Email typed successfully');
        
        await HumanEmulation.randomDelay(500, 1000);
        await page.keyboard.press('Enter');
        console.log('Pressed Enter after email');
        await HumanEmulation.randomDelay(2000, 4000);
      } catch (typeError) {
        if (typeError.message.includes('detached') || typeError.message.includes('closed') || typeError.message.includes('Target closed')) {
          console.log('Page detached while typing email');
          throw new Error('Page was closed during email input');
        }
        console.error('Error typing email:', typeError.message);
        throw typeError;
      }

      // Wait for password input
      const passwordSelectors = [
        'input[type="password"]',
        'input[name="password"]',
        'input[id*="password"]',
        'input[autocomplete="current-password"]'
      ];
      
      let passwordInput = null;
      let passwordSelector = null;
      
      for (const selector of passwordSelectors) {
        try {
          passwordInput = await page.waitForSelector(selector, { timeout: 10000 });
          if (passwordInput) {
            passwordSelector = selector;
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      // If not found, try finding by evaluate
      if (!passwordInput) {
        const foundPassword = await page.evaluateHandle(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          return inputs.find(input => {
            const type = input.type.toLowerCase();
            const name = (input.name || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            const label = (input.getAttribute('aria-label') || '').toLowerCase();
            const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
            
            return type === 'password' ||
                   name.includes('password') ||
                   id.includes('password') ||
                   label.includes('password') ||
                   autocomplete.includes('password');
          });
        });
        
        if (foundPassword && foundPassword.asElement()) {
          passwordInput = foundPassword.asElement();
        }
      }
      
      if (passwordInput) {
        // Type password using the element directly
        try {
          // Focus the input first
          await passwordInput.focus();
          await HumanEmulation.randomDelay(200, 500);
          
          // Clear any existing text
          await passwordInput.click({ clickCount: 3 }); // Triple click to select all
          await page.keyboard.press('Backspace');
          await HumanEmulation.randomDelay(100, 200);
          
          console.log('Typing password...');
          await passwordInput.type(profile.password, { delay: 50 + Math.random() * 50 });
          console.log('Password typed successfully');
          
          await HumanEmulation.randomDelay(500, 1000);
          await page.keyboard.press('Enter');
          console.log('Pressed Enter after password');
          await HumanEmulation.randomDelay(5000, 8000);
        } catch (typeError) {
          if (typeError.message.includes('detached') || typeError.message.includes('closed') || typeError.message.includes('Target closed')) {
            console.log('Page detached while typing password');
            throw new Error('Page was closed during password input');
          }
          console.error('Error typing password:', typeError.message);
          throw typeError;
        }
      } else {
        console.log('Password input not found - may not be needed or page structure changed');
      }
      
      // Wait for navigation to Gmail or check for challenges
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      } catch (navError) {
        console.log('Navigation timeout, checking for challenges...');
      }

      // Check for recovery email selection screen
      await this.handleRecoveryEmailSelection(page, profile);
      
      // Check for "Verify it's you" screen with recovery email confirmation option
      await this.handleRecoveryEmailVerification(page, profile);
      
      console.log('=== handleLogin COMPLETED SUCCESSFULLY ===');
      
      // Check for verification challenges
      const verifyChallenge = await page.evaluate(() => {
        const bodyText = document.body.textContent.toLowerCase();
        const hasChallenge = /verify|sms|phone|challenge/i.test(bodyText);
        
        // Also check for challenge-related buttons/inputs
        const challengeElements = Array.from(document.querySelectorAll('button, input, div, span'))
          .filter(el => {
            const text = el.textContent.toLowerCase();
            return /verify|sms|phone|challenge/i.test(text);
          });
        
        return hasChallenge || challengeElements.length > 0;
      });
      
      let smsVerificationAttempted = false;
      if (verifyChallenge) {
        console.log('Verification challenge detected');
        smsVerificationAttempted = true;
        
        try {
          await this.handleSMSVerification(page);
        } catch (smsError) {
          console.log('SMS verification failed, checking for alternative verification methods...');
          // Try to find and click "Try another way" or other verification options
          await this.tryAlternativeVerification(page);
        }
        
        // Wait a bit after verification attempt
        await HumanEmulation.randomDelay(3000, 5000);
      }
      
      // Check if login was successful - wait a bit more for navigation
      await HumanEmulation.randomDelay(2000, 3000);
      const currentUrl = page.url();
      const isStillOnChallenge = currentUrl.includes('accounts.google.com') && 
                                 (currentUrl.includes('signin') || currentUrl.includes('challenge'));
      const isOnGmail = currentUrl.includes('mail.google.com') || currentUrl.includes('workspace.google.com');
      
      console.log(`Final URL check: ${currentUrl}`);
      console.log(`  - Is on challenge: ${isStillOnChallenge}`);
      console.log(`  - Is on Gmail: ${isOnGmail}`);
      
      if (isStillOnChallenge && !isOnGmail) {
        if (smsVerificationAttempted) {
          console.log('⚠ Still on challenge page after SMS verification attempt');
          console.log('⚠ SMS verification may need to be completed manually, or SMSPool API may need configuration');
          console.log('⚠ Attempting to find and click "Try another way" or skip options...');
          
          // Try to find alternative verification methods
          await this.tryAlternativeVerification(page);
          
          // Wait a bit more after trying alternative
          await HumanEmulation.randomDelay(3000, 5000);
          
          // Re-check URL
          const finalUrl = page.url();
          if (finalUrl.includes('mail.google.com') || finalUrl.includes('workspace.google.com')) {
            console.log('✓ Successfully bypassed challenge, now on Gmail');
          } else {
            console.log('⚠ Still on challenge page - manual intervention required');
            console.log('⚠ Login process will continue, but you may need to complete verification manually');
            // Don't throw - allow the process to continue
          }
        } else {
          console.log('Still on login/challenge page, login may have failed');
          // Only throw if we didn't attempt SMS verification
          throw new Error('Login unsuccessful - still on login page');
        }
      } else if (isOnGmail) {
        console.log('✓ Login completed successfully, redirected to Gmail');
      } else {
        console.log('Login status unclear, URL:', currentUrl);
      }
      
      console.log('Login completed, redirected to:', currentUrl);
      console.log('=== handleLogin FINISHED SUCCESSFULLY ===');
    } catch (error) {
      console.error('=== handleLogin FAILED ===');
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      throw error;
    }
  }

  async handleRecoveryEmailSelection(page, profile) {
    try {
      // Wait a bit for page to load
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Check if we're on a recovery email selection screen
      const isRecoveryEmailScreen = await page.evaluate(() => {
        const bodyText = document.body.textContent.toLowerCase();
        const url = window.location.href.toLowerCase();
        
        // Check URL for recovery/challenge indicators
        const isChallengeUrl = url.includes('challenge') || url.includes('recovery') || url.includes('select');
        
        // Check page text for recovery email prompts
        const hasRecoveryText = /which.*email|recovery.*email|select.*email|email.*address.*use|email.*you.*use|email.*set.*up/i.test(bodyText);
        
        // Check for email selection buttons/options (Google typically shows email addresses as clickable options)
        const emailOptions = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a, li'))
          .filter(el => {
            const text = el.textContent || '';
            // Look for elements that contain email addresses (contains @ and domain)
            const hasEmail = text.includes('@') && (text.includes('.com') || text.includes('.net') || text.includes('.org'));
            // Or elements with recovery-related text
            const hasRecoveryText = /recovery|which.*email|select.*email|email.*address/i.test(text.toLowerCase());
            return hasEmail || hasRecoveryText;
          });
        
        // Also check for radio buttons or checkboxes (Google sometimes uses these)
        const radioButtons = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
          .filter(input => {
            const label = input.closest('label') || input.parentElement;
            const text = label ? label.textContent || '' : '';
            return text.includes('@');
          });
        
        return isChallengeUrl || hasRecoveryText || emailOptions.length > 0 || radioButtons.length > 0;
      });
      
      if (!isRecoveryEmailScreen) {
        console.log('No recovery email selection screen detected');
        return;
      }
      
      console.log('Recovery email selection screen detected');
      
      if (!profile.recoveryEmail) {
        console.log('No recovery email provided in profile, cannot select recovery email');
        return;
      }
      
      console.log(`Looking for recovery email: ${profile.recoveryEmail}`);
      
      // Try to find and click the recovery email option
      const recoveryEmailSelected = await page.evaluate((recoveryEmail) => {
        const normalizedRecoveryEmail = recoveryEmail.toLowerCase().trim();
        
        // First, try to find radio buttons or checkboxes with matching labels
        const radioInputs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
        for (const input of radioInputs) {
          const label = input.closest('label') || 
                       document.querySelector(`label[for="${input.id}"]`) ||
                       input.parentElement;
          const labelText = label ? (label.textContent || '').toLowerCase() : '';
          if (labelText.includes(normalizedRecoveryEmail)) {
            try {
              input.click();
              return true;
            } catch (e) {
              // Try clicking the label instead
              if (label && label.click) {
                label.click();
                return true;
              }
            }
          }
        }
        
        // Look for buttons, divs, spans, or list items that contain the recovery email
        const allElements = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"], a, li, div'));
        
        for (const el of allElements) {
          const text = (el.textContent || '').toLowerCase().trim();
          // Check if element contains the recovery email (exact or partial match)
          if (text.includes(normalizedRecoveryEmail) || 
              text === normalizedRecoveryEmail ||
              text.includes(recoveryEmail.split('@')[0]) || // Username match
              text.includes(recoveryEmail.split('@')[1])) { // Domain match
            // Try to click it
            try {
              // Check if element is visible and clickable
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.click();
                return true;
              }
            } catch (e) {
              // If direct click fails, try finding parent clickable element
              let clickable = el;
              while (clickable && clickable !== document.body) {
                if (clickable.tagName === 'BUTTON' || clickable.tagName === 'A' || 
                    clickable.getAttribute('role') === 'button' ||
                    clickable.onclick !== null) {
                  try {
                    clickable.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    clickable.click();
                    return true;
                  } catch (clickError) {
                    break;
                  }
                }
                clickable = clickable.parentElement;
              }
            }
          }
        }
        return false;
      }, profile.recoveryEmail);
      
      if (recoveryEmailSelected) {
        console.log(`✓ Successfully selected recovery email: ${profile.recoveryEmail}`);
        await HumanEmulation.randomDelay(2000, 3000);
        
        // Wait for navigation after selection
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
        } catch (navError) {
          console.log('Navigation after recovery email selection completed or timed out');
        }
      } else {
        console.log(`Could not find recovery email option: ${profile.recoveryEmail}`);
        console.log('Attempting to find by partial match...');
        
        // Try partial match (just the domain or username)
        const emailParts = profile.recoveryEmail.split('@');
        const username = emailParts[0];
        const domain = emailParts[1];
        
        const partialMatch = await page.evaluate((username, domain) => {
          const allElements = Array.from(document.querySelectorAll('button, div, span, a, li'));
          
          for (const el of allElements) {
            const text = el.textContent || '';
            // Check if element contains username or domain
            if (text.includes(username) || text.includes(domain)) {
              try {
                el.click();
                return true;
              } catch (e) {
                let clickable = el;
                while (clickable && clickable !== document.body) {
                  if (clickable.tagName === 'BUTTON' || clickable.tagName === 'A' || 
                      clickable.getAttribute('role') === 'button') {
                    clickable.click();
                    return true;
                  }
                  clickable = clickable.parentElement;
                }
              }
            }
          }
          return false;
        }, username, domain);
        
        if (partialMatch) {
          console.log(`✓ Selected recovery email using partial match`);
          await HumanEmulation.randomDelay(2000, 3000);
          try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
          } catch (navError) {
            console.log('Navigation after partial match completed or timed out');
          }
        } else {
          console.log('Could not find recovery email option even with partial match');
          console.log('You may need to manually select the recovery email');
        }
      }
    } catch (error) {
      console.error('Error handling recovery email selection:', error.message);
      // Don't throw - recovery email selection is not critical for login
    }
  }

  async handleRecoveryEmailVerification(page, profile) {
    try {
      // Wait a bit for page to load
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Check if we're on the "Verify it's you" screen
      const screenInfo = await page.evaluate(() => {
        const bodyText = document.body.textContent.toLowerCase();
        const url = window.location.href.toLowerCase();
        const title = document.title.toLowerCase();
        
        // Check for "Verify it's you" text
        const hasVerifyText = /verify.*it.*you|verify.*your.*identity|verify.*you/i.test(bodyText);
        
        // Check URL for challenge/verification
        const isChallengeUrl = url.includes('challenge') || url.includes('verification') || url.includes('verify');
        
        // Check for "Confirm your recovery email" option in body text
        const hasRecoveryEmailInBody = /confirm.*recovery.*email|recovery.*email/i.test(bodyText);
        
        // Look for the specific option text in elements
        const allElements = Array.from(document.querySelectorAll('div, span, button, a, li, [role="button"], [role="option"]'));
        const recoveryEmailElements = allElements.filter(el => {
          const text = (el.textContent || '').toLowerCase();
          return /confirm.*recovery.*email|recovery.*email/i.test(text);
        });
        
        // Get sample text from page for debugging
        const sampleText = bodyText.substring(0, 500);
        
        return {
          url,
          title,
          hasVerifyText,
          isChallengeUrl,
          hasRecoveryEmailInBody,
          hasRecoveryOption: recoveryEmailElements.length > 0,
          recoveryOptionCount: recoveryEmailElements.length,
          sampleText,
          // Return true if we find recovery email option (more lenient)
          isVerificationScreen: hasRecoveryEmailInBody || recoveryEmailElements.length > 0 || (hasVerifyText && isChallengeUrl)
        };
      });
      
      console.log('Recovery email verification screen check:', JSON.stringify(screenInfo, null, 2));
      
      if (!screenInfo.isVerificationScreen) {
        console.log('No recovery email verification screen detected');
        console.log(`  - URL: ${screenInfo.url}`);
        console.log(`  - Has verify text: ${screenInfo.hasVerifyText}`);
        console.log(`  - Is challenge URL: ${screenInfo.isChallengeUrl}`);
        console.log(`  - Has recovery email in body: ${screenInfo.hasRecoveryEmailInBody}`);
        console.log(`  - Has recovery option elements: ${screenInfo.hasRecoveryOption} (${screenInfo.recoveryOptionCount} found)`);
        return;
      }
      
      console.log('✓ Recovery email verification screen detected');
      console.log(`  - Found ${screenInfo.recoveryOptionCount} recovery email option elements`);
      
      if (!profile.recoveryEmail) {
        console.log('No recovery email provided in profile, cannot confirm recovery email');
        return;
      }
      
      console.log(`Looking for "Confirm your recovery email" option...`);
      
      // First, let's see what elements we have
      const elementInfo = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('div, span, button, a, li, [role="button"], [role="option"], p'));
        const recoveryElements = allElements.filter(el => {
          const text = (el.textContent || '').toLowerCase().trim();
          return /confirm.*recovery.*email|recovery.*email.*confirm|recovery.*email/i.test(text);
        });
        
        return recoveryElements.map(el => ({
          tag: el.tagName,
          text: (el.textContent || '').substring(0, 150),
          role: el.getAttribute('role'),
          className: el.className,
          id: el.id,
          isVisible: window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden'
        }));
      });
      
      console.log(`Found ${elementInfo.length} recovery email related elements`);
      if (elementInfo.length > 0) {
        console.log('Sample elements:', JSON.stringify(elementInfo.slice(0, 3), null, 2));
      }
      
      // Find and click the "Confirm your recovery email" option - simpler approach
      const optionClicked = await page.evaluate(() => {
        // First, try to find elements with "Confirm your recovery email" text specifically
        const allElements = Array.from(document.querySelectorAll('*'));
        
        // Priority 1: Exact match for "Confirm your recovery email"
        for (const el of allElements) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (/confirm.*your.*recovery.*email/i.test(text) && text.length < 100) {
            console.log('Found exact match:', text);
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              try {
                // Try clicking element or its clickable parent
                let toClick = el;
                for (let i = 0; i < 3; i++) {
                  if (toClick.tagName === 'BUTTON' || toClick.tagName === 'A' || 
                      toClick.getAttribute('role') === 'button' || toClick.onclick) {
                    toClick.scrollIntoView({ block: 'center' });
                    toClick.click();
                    return { success: true, method: 'exact-match' };
                  }
                  toClick = toClick.parentElement;
                  if (!toClick || toClick === document.body) break;
                }
              } catch (e) {
                console.log('Click error:', e.message);
              }
            }
          }
        }
        
        // Priority 2: Elements with "recovery email" that are clickable
        for (const el of allElements) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (/recovery.*email/i.test(text) && text.length > 10 && text.length < 150) {
            try {
              // Check if element is visible
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.click();
                return { success: true, method: 'direct' };
              }
            } catch (e) {
              console.log('Error checking visibility:', e.message);
            }
            
            // Try parent element
            let clickable = el;
            let depth = 0;
            while (clickable && clickable !== document.body && depth < 5) {
              try {
                const style = window.getComputedStyle(clickable);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  if (clickable.tagName === 'BUTTON' || clickable.tagName === 'A' || 
                      clickable.getAttribute('role') === 'button' ||
                      clickable.getAttribute('role') === 'option' ||
                      clickable.onclick !== null ||
                      clickable.style.cursor === 'pointer') {
                    clickable.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    clickable.click();
                    return { success: true, method: 'parent', depth };
                  }
                }
              } catch (parentError) {
                console.log(`Parent click failed at depth ${depth}:`, parentError.message);
              }
              clickable = clickable.parentElement;
              depth++;
            }
          }
        }
        return { success: false, reason: 'not found' };
      });
      
      // If evaluate click didn't work, try using Puppeteer's click method
      if (!optionClicked || !optionClicked.success) {
        console.log('Evaluate click failed, trying Puppeteer click method...');
        
        // Find the element using Puppeteer
        const recoveryOption = await page.evaluateHandle(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
          for (const el of allElements) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (/confirm.*your.*recovery.*email|confirm.*recovery.*email/i.test(text) && text.length < 100) {
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                return el;
              }
            }
          }
          // Fallback: find any element with recovery email
          for (const el of allElements) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (/recovery.*email/i.test(text) && text.length > 10 && text.length < 150) {
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                // Find clickable parent
                let clickable = el;
                for (let i = 0; i < 5; i++) {
                  if (clickable.tagName === 'BUTTON' || clickable.tagName === 'A' || 
                      clickable.getAttribute('role') === 'button' || clickable.onclick) {
                    return clickable;
                  }
                  clickable = clickable.parentElement;
                  if (!clickable || clickable === document.body) break;
                }
                return el;
              }
            }
          }
          return null;
        });
        
        if (recoveryOption && recoveryOption.asElement()) {
          try {
            const element = recoveryOption.asElement();
            await element.scrollIntoView();
            await HumanEmulation.randomDelay(300, 500);
            await element.click();
            console.log('✓ Clicked recovery email option using Puppeteer method');
            optionClicked = { success: true, method: 'puppeteer-click' };
          } catch (puppeteerClickError) {
            console.log('Puppeteer click failed:', puppeteerClickError.message);
          }
        }
      }
      
      if (!optionClicked || !optionClicked.success) {
        console.log('✗ Could not find or click "Confirm your recovery email" option');
        if (optionClicked && optionClicked.reason) {
          console.log(`  Reason: ${optionClicked.reason}`);
        }
        // Try to take a screenshot for debugging
        try {
          await page.screenshot({ path: 'recovery-email-verification-debug.png' });
          console.log('Screenshot saved as recovery-email-verification-debug.png');
        } catch (screenshotError) {
          console.log('Could not take screenshot:', screenshotError.message);
        }
        return;
      }
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Wait for navigation or input field to appear
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      } catch (navError) {
        console.log('Navigation wait completed or timed out');
      }
      
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Now look for the recovery email input field
      console.log(`Looking for recovery email input field to type: ${profile.recoveryEmail}`);
      
      const emailInputSelectors = [
        'input[type="email"]',
        'input[name*="email"]',
        'input[id*="email"]',
        'input[autocomplete*="email"]',
        'input[placeholder*="email" i]'
      ];
      
      let emailInput = null;
      
      for (const selector of emailInputSelectors) {
        try {
          emailInput = await page.waitForSelector(selector, { timeout: 5000 });
          if (emailInput) {
            console.log(`Found recovery email input using selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      // If not found by selectors, try finding by evaluate
      if (!emailInput) {
        const foundInput = await page.evaluateHandle(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          return inputs.find(input => {
            const type = input.type.toLowerCase();
            const name = (input.name || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            const placeholder = (input.placeholder || '').toLowerCase();
            const label = (input.getAttribute('aria-label') || '').toLowerCase();
            
            return type === 'email' ||
                   type === 'text' ||
                   name.includes('email') ||
                   id.includes('email') ||
                   placeholder.includes('email') ||
                   label.includes('email') ||
                   label.includes('recovery');
          });
        });
        
        if (foundInput && foundInput.asElement()) {
          emailInput = foundInput.asElement();
          console.log('Found recovery email input using evaluate');
        }
      }
      
      if (emailInput) {
        try {
          await emailInput.focus();
          await HumanEmulation.randomDelay(200, 500);
          
          // Clear any existing text
          await emailInput.click({ clickCount: 3 });
          await page.keyboard.press('Backspace');
          await HumanEmulation.randomDelay(100, 200);
          
          console.log(`Typing recovery email: ${profile.recoveryEmail}`);
          await emailInput.type(profile.recoveryEmail, { delay: 50 + Math.random() * 50 });
          console.log('✓ Recovery email typed successfully');
          
          await HumanEmulation.randomDelay(500, 1000);
          await page.keyboard.press('Enter');
          console.log('Pressed Enter after recovery email');
          await HumanEmulation.randomDelay(2000, 4000);
          
          // Wait for navigation
          try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
          } catch (navError) {
            console.log('Navigation after recovery email input completed or timed out');
          }
        } catch (typeError) {
          if (typeError.message.includes('detached') || typeError.message.includes('closed')) {
            console.log('Page detached while typing recovery email');
            return;
          }
          console.error('Error typing recovery email:', typeError.message);
          throw typeError;
        }
      } else {
        console.log('Recovery email input field not found');
      }
    } catch (error) {
      console.error('Error handling recovery email verification:', error.message);
      // Don't throw - recovery email verification is not critical for login
    }
  }

  async tryAlternativeVerification(page) {
    try {
      console.log('Looking for alternative verification methods...');
      
      const alternativeClicked = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('div, span, button, a, [role="button"]'));
        
        // Look for "Try another way" or similar options
        for (const el of allElements) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (/try.*another.*way|use.*another.*method|different.*way|skip|cancel/i.test(text)) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              try {
                el.scrollIntoView({ block: 'center' });
                el.click();
                return { success: true, text: text.substring(0, 50) };
              } catch (e) {
                // Try parent
                let clickable = el;
                for (let i = 0; i < 3; i++) {
                  if (clickable && clickable !== document.body) {
                    try {
                      clickable.scrollIntoView({ block: 'center' });
                      clickable.click();
                      return { success: true, text: text.substring(0, 50), method: 'parent' };
                    } catch (pe) {
                      clickable = clickable.parentElement;
                    }
                  }
                }
              }
            }
          }
        }
        return { success: false };
      });
      
      if (alternativeClicked && alternativeClicked.success) {
        console.log(`✓ Clicked alternative verification option: ${alternativeClicked.text}`);
        await HumanEmulation.randomDelay(2000, 3000);
      } else {
        console.log('No alternative verification method found');
      }
    } catch (error) {
      console.log('Error trying alternative verification:', error.message);
    }
  }

  async handleSMSVerification(page) {
    try {
      console.log('SMS verification challenge detected, attempting to handle...');
      
      if (!this.smspool.apiKey) {
        console.log('SMSPool API key not configured, skipping SMS verification');
        console.log('Please configure SMSPOOL_API_KEY in .env file to enable SMS verification');
        throw new Error('SMS verification required but SMSPool API key not configured');
      }

      const rentResult = await this.smspool.rentNumber('google');
      
      if (!rentResult || !rentResult.orderId || !rentResult.number) {
        console.log('Could not rent phone number from SMSPool - SMS verification cannot be automated');
        console.log('Please complete SMS verification manually or configure SMSPool API correctly');
        return; // Exit gracefully without throwing
      }
      
      const { orderId, number } = rentResult;
      console.log(`Rented phone number: ${number} (Order ID: ${orderId})`);
      
      // Find phone input field
      const phoneSelectors = [
        'input[type="tel"]',
        'input[name*="phone"]',
        'input[id*="phone"]',
        'input[aria-label*="phone" i]'
      ];
      
      let phoneInput = null;
      for (const selector of phoneSelectors) {
        try {
          phoneInput = await page.waitForSelector(selector, { timeout: 5000 });
          if (phoneInput) break;
        } catch (e) {
          continue;
        }
      }
      
      // Try finding by evaluate if not found
      if (!phoneInput) {
        const foundPhone = await page.evaluateHandle(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          return inputs.find(input => {
            const type = input.type.toLowerCase();
            const name = (input.name || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            const label = (input.getAttribute('aria-label') || '').toLowerCase();
            return type === 'tel' || name.includes('phone') || id.includes('phone') || label.includes('phone');
          });
        });
        
        if (foundPhone && foundPhone.asElement()) {
          phoneInput = foundPhone.asElement();
        }
      }
      
      if (phoneInput) {
        await phoneInput.type(number, { delay: 50 + Math.random() * 50 });
        await page.keyboard.press('Enter');
        await HumanEmulation.randomDelay(2000, 3000);
      } else {
        console.log('Phone input field not found');
      }

      // Wait for SMS code
      console.log('Waiting for SMS code...');
      const smsCode = await this.smspool.waitForSMS(orderId);
      console.log(`Received SMS code: ${smsCode}`);
      
      // Find code input field
      const codeSelectors = [
        'input[type="text"][maxlength="6"]',
        'input[type="text"][maxlength="8"]',
        'input[name*="code"]',
        'input[id*="code"]'
      ];
      
      let codeInput = null;
      for (const selector of codeSelectors) {
        try {
          codeInput = await page.waitForSelector(selector, { timeout: 5000 });
          if (codeInput) break;
        } catch (e) {
          continue;
        }
      }
      
      if (codeInput) {
        await codeInput.type(smsCode, { delay: 50 + Math.random() * 50 });
        await page.keyboard.press('Enter');
      } else {
        console.log('Code input field not found, trying to type anywhere');
        await page.keyboard.type(smsCode, { delay: 100 });
        await page.keyboard.press('Enter');
      }

      await HumanEmulation.randomDelay(2000, 3000);
    } catch (error) {
      console.error('SMS verification error:', error.message);
      // Don't throw - let the login process continue without SMS verification
      console.log('Continuing without SMS verification...');
    }
  }
}
