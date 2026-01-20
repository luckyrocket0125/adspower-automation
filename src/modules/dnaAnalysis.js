import { AdsPowerService } from '../services/adspower.js';
import { analyzePersonaFromEmails } from '../services/openai.js';
import { Profile } from '../models/Profile.js';
import { InteractionLog } from '../models/InteractionLog.js';
import { HumanEmulation } from '../utils/humanEmulation.js';
import { SMSPoolService } from '../services/smspool.js';
import { CapMonsterService } from '../services/capmonster.js';
import dotenv from 'dotenv';

dotenv.config();

export class DNAAnalysis {
  constructor() {
    this.adspower = new AdsPowerService();
    this.smspool = new SMSPoolService();
    this.capmonster = new CapMonsterService();
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
      
      // Try to get existing page first, with timeout handling
      let page = null;
      try {
        const pages = await browser.pages();
        page = pages[0];
      } catch (pagesError) {
        console.log('Could not get existing pages, will create new page');
      }
      
      // Create new page if needed, with retry logic
      if (!page) {
        let retries = 3;
        while (retries > 0 && !page) {
          try {
            page = await Promise.race([
              browser.newPage(),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Page creation timeout')), 30000)
              )
            ]);
            console.log('✓ New page created successfully');
          } catch (pageError) {
            retries--;
            console.log(`Page creation failed, ${retries} retries left:`, pageError.message);
            if (retries > 0) {
              await HumanEmulation.randomDelay(2000, 3000);
            } else {
              throw new Error(`Failed to create page after 3 attempts: ${pageError.message}`);
            }
          }
        }
      } else {
        console.log('✓ Using existing page');
      }

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
          try {
            const pages = await browser.pages();
            page = pages[0];
          } catch (e) {
            page = null;
          }
          
          if (!page) {
            try {
              page = await Promise.race([
                browser.newPage(),
                new Promise((_, reject) => 
                  setTimeout(() => reject(new Error('Page creation timeout')), 30000)
                )
              ]);
            } catch (pageError) {
              throw new Error(`Failed to create new page after navigation error: ${pageError.message}`);
            }
          }
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

      console.log('=== Starting Gmail email scraping ===');
      let emailData = await this.scrapeGmail(page, profile);
      console.log(`✓ Scraped ${emailData?.length || 0} email(s) from Gmail`);
      
      // Check if we have enough meaningful email data (at least 3 emails with content)
      const hasEnoughData = emailData && emailData.length >= 3 && 
                           emailData.some(email => (email.subject || email.snippet || email.rawText) && 
                                          (email.subject?.length > 10 || email.snippet?.length > 20 || email.rawText?.length > 20));
      
      if (!hasEnoughData) {
        console.log(`⚠ Insufficient email data (${emailData?.length || 0} emails) - attempting to scrape account settings`);
        
        // Try to scrape account settings as fallback
        const settingsData = await this.scrapeGmailAccountSettings(page, profile);
        
        if (settingsData && settingsData.length > 0) {
          console.log('✓ Account settings data retrieved, using as primary data source');
          emailData = settingsData;
        } else {
          console.log('⚠ Account settings scraping failed, trying basic fallback data');
          emailData = await this.getFallbackData(page);
          console.log(`Fallback data retrieved: ${emailData?.length || 0} item(s)`);
        }
        
        if (!emailData || emailData.length === 0) {
          console.error('✗ No email data or account settings available - cannot perform analysis');
          throw new Error('No email data or account settings could be scraped from Gmail');
        }
      } else {
        console.log('✓ Sufficient email data found for analysis');
      }
      
      console.log('Email data sample:', emailData?.slice(0, 2));
      console.log('=== Sending email data to OpenAI for persona analysis ===');
      console.log(`Email data to analyze: ${JSON.stringify(emailData.slice(0, Math.min(5, emailData.length)), null, 2)}`);
      
      let persona;
      try {
        persona = await analyzePersonaFromEmails(emailData);
        console.log('✓ OpenAI analysis completed');
        console.log('Persona result:', persona);
        
        if (!persona || !persona.gender || !persona.ageBracket) {
          console.error('⚠ OpenAI returned invalid persona data:', persona);
          throw new Error('OpenAI analysis returned invalid data');
        }
        
        console.log('=== Updating profile persona in database ===');
        await Profile.updatePersona(profileId, persona);
        console.log('✓ Profile persona updated in database');
        
        const interests = persona.interests && Array.isArray(persona.interests) 
          ? persona.interests.slice(0, 3).join(', ') 
          : 'No interests';
        const notesText = `${persona.gender} | ${persona.ageBracket} | ${interests}`;
        console.log(`=== Updating AdsPower profile notes: "${notesText}" ===`);
        
        try {
          await this.adspower.updateProfileNotes(profileId, notesText);
          console.log('✓ AdsPower profile notes updated successfully');
        } catch (notesError) {
          console.error('✗ Failed to update AdsPower profile notes:', notesError.message);
          console.error('Persona data was still saved to database');
          // Don't throw - notes update failure shouldn't stop the process
        }
      } catch (openaiError) {
        console.error('✗ OpenAI analysis failed:', openaiError.message);
        throw openaiError;
      }

      const log = new InteractionLog({
        profileId,
        action: 'dna_analysis',
        url: 'https://gmail.com',
        success: true,
        metadata: { persona: persona || null }
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

  async scrapeGmailAccountSettings(page, profile) {
    console.log('=== Scraping Gmail account settings as fallback ===');
    try {
      if (page.isClosed()) {
        console.log('Page closed, cannot scrape account settings');
        return null;
      }

      const currentUrl = page.url();
      console.log(`Current URL before settings navigation: ${currentUrl}`);

      // Navigate to Google Account settings page
      try {
        await page.goto('https://myaccount.google.com/personal-info', { 
          waitUntil: 'networkidle2', 
          timeout: 30000 
        });
        await HumanEmulation.randomDelay(3000, 5000);
      } catch (navError) {
        if (navError.message.includes('detached') || navError.message.includes('closed')) {
          console.log('Page detached during settings navigation');
          return null;
        }
        throw navError;
      }

      if (page.isClosed()) {
        console.log('Page closed after settings navigation');
        return null;
      }

      // Check if we're logged in - if redirected to sign-in, try alternative approach
      const settingsUrl = page.url();
      if (settingsUrl.includes('accounts.google.com/signin')) {
        console.log('Redirected to sign-in page, trying alternative settings URL...');
        try {
          await page.goto('https://myaccount.google.com/', { 
            waitUntil: 'networkidle2', 
            timeout: 30000 
          });
          await HumanEmulation.randomDelay(2000, 4000);
        } catch (altNavError) {
          console.log('Alternative settings navigation failed:', altNavError.message);
        }
      }

      // Scrape account information from settings page
      const accountData = await page.evaluate(() => {
        const data = {
          email: '',
          name: '',
          displayName: '',
          birthday: '',
          gender: '',
          location: '',
          language: '',
          accountCreated: '',
          recoveryEmail: '',
          phoneNumber: ''
        };

        // Try to find email from various sources
        const emailSelectors = [
          'input[type="email"]',
          '[data-email]',
          'div[data-email]',
          'span[data-email]',
          'a[href^="mailto:"]'
        ];
        for (const selector of emailSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            data.email = element.value || element.getAttribute('data-email') || 
                        element.textContent || element.getAttribute('href')?.replace('mailto:', '') || '';
            if (data.email) break;
          }
        }

        // Try to find name
        const nameSelectors = [
          '[data-name]',
          'input[name*="name"]',
          'div[data-name]',
          'span[data-name]',
          'h1',
          'h2'
        ];
        for (const selector of nameSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            const name = element.getAttribute('data-name') || element.textContent?.trim() || '';
            if (name && name.length > 1 && name.length < 100) {
              data.name = name;
              break;
            }
          }
        }

        // Try to find display name
        const displayNameEl = document.querySelector('[data-display-name]') || 
                              document.querySelector('input[placeholder*="name" i]');
        if (displayNameEl) {
          data.displayName = displayNameEl.getAttribute('data-display-name') || 
                            displayNameEl.value || displayNameEl.textContent || '';
        }

        // Try to find birthday/age
        const birthdaySelectors = [
          'input[type="date"]',
          'input[name*="birth"]',
          'input[name*="date"]',
          '[data-birthday]',
          '[data-date-of-birth]'
        ];
        for (const selector of birthdaySelectors) {
          const element = document.querySelector(selector);
          if (element) {
            data.birthday = element.value || element.getAttribute('data-birthday') || 
                          element.getAttribute('data-date-of-birth') || '';
            if (data.birthday) break;
          }
        }

        // Try to find gender
        const genderSelectors = [
          'select[name*="gender"]',
          'input[name*="gender"]',
          '[data-gender]'
        ];
        for (const selector of genderSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            data.gender = element.value || element.getAttribute('data-gender') || 
                         element.textContent || '';
            if (data.gender) break;
          }
        }

        // Try to find location
        const locationEl = document.querySelector('input[name*="location"]') ||
                          document.querySelector('[data-location]');
        if (locationEl) {
          data.location = locationEl.value || locationEl.getAttribute('data-location') || '';
        }

        // Try to find language
        const languageEl = document.querySelector('select[name*="language"]') ||
                          document.querySelector('[data-language]');
        if (languageEl) {
          data.language = languageEl.value || languageEl.getAttribute('data-language') || '';
        }

        // Try to find recovery email
        const recoveryEmailEl = document.querySelector('input[type="email"][name*="recovery"]') ||
                                document.querySelector('[data-recovery-email]');
        if (recoveryEmailEl) {
          data.recoveryEmail = recoveryEmailEl.value || recoveryEmailEl.getAttribute('data-recovery-email') || '';
        }

        // Try to find phone number
        const phoneEl = document.querySelector('input[type="tel"]') ||
                       document.querySelector('input[name*="phone"]');
        if (phoneEl) {
          data.phoneNumber = phoneEl.value || '';
        }

        // Try to extract from page text content
        const pageText = document.body.textContent || '';
        
        // Look for email pattern in text
        if (!data.email) {
          const emailMatch = pageText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
          if (emailMatch) {
            data.email = emailMatch[0];
          }
        }

        // Look for date patterns (birthday)
        if (!data.birthday) {
          const dateMatch = pageText.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/);
          if (dateMatch) {
            data.birthday = dateMatch[0];
          }
        }

        return data;
      });

      console.log('Account settings data scraped:', accountData);

      // Also try to get data from Gmail profile (if still on Gmail)
      let gmailProfileData = null;
      try {
        await page.goto('https://mail.google.com/mail/u/0/#settings/general', { 
          waitUntil: 'networkidle2', 
          timeout: 20000 
        }).catch(() => {});
        
        await HumanEmulation.randomDelay(2000, 3000);
        
        if (!page.isClosed()) {
          gmailProfileData = await page.evaluate(() => {
            const data = {};
            
            // Try to find email from Gmail settings
            const emailEl = document.querySelector('input[type="email"]') ||
                           document.querySelector('[data-email]');
            if (emailEl) {
              data.email = emailEl.value || emailEl.getAttribute('data-email') || '';
            }

            // Try to find name from Gmail settings
            const nameEl = document.querySelector('input[name*="name"]') ||
                          document.querySelector('[data-name]');
            if (nameEl) {
              data.name = nameEl.value || nameEl.getAttribute('data-name') || '';
            }

            return data;
          });
          
          if (gmailProfileData && (gmailProfileData.email || gmailProfileData.name)) {
            console.log('Gmail profile data found:', gmailProfileData);
            accountData.email = accountData.email || gmailProfileData.email || '';
            accountData.name = accountData.name || gmailProfileData.name || '';
          }
        }
      } catch (gmailError) {
        console.log('Could not access Gmail settings:', gmailError.message);
      }

      // Use profile data as fallback
      if (!accountData.email && profile.email) {
        accountData.email = profile.email;
      }
      if (!accountData.name && profile.persona?.name) {
        accountData.name = profile.persona.name;
      }
      if (!accountData.recoveryEmail && profile.recoveryEmail) {
        accountData.recoveryEmail = profile.recoveryEmail;
      }

      // Format as email-like data structure for OpenAI analysis
      const formattedData = [{
        type: 'account_settings',
        email: accountData.email,
        name: accountData.name || accountData.displayName,
        birthday: accountData.birthday,
        gender: accountData.gender,
        location: accountData.location,
        language: accountData.language,
        recoveryEmail: accountData.recoveryEmail,
        phoneNumber: accountData.phoneNumber,
        accountCreated: accountData.accountCreated,
        note: 'Account settings data - insufficient email activity'
      }];

      console.log('Formatted account settings data:', formattedData);
      return formattedData;

    } catch (error) {
      console.error('Error scraping Gmail account settings:', error.message);
      return null;
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
        
        // Check for CAPTCHA after email entry
        await this.handleCaptcha(page);
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
          
          // Check for CAPTCHA immediately after password entry
          await HumanEmulation.randomDelay(2000, 3000);
          await this.handleCaptcha(page);
          
          // Immediately check for "Confirm your recovery email" option (check multiple times)
          console.log('Checking for recovery email confirmation option immediately after password...');
          for (let attempt = 0; attempt < 5; attempt++) {
            await HumanEmulation.randomDelay(1000, 2000);
            
            const hasRecoveryOption = await page.evaluate(() => {
              const bodyText = document.body.textContent.toLowerCase();
              const hasText = /confirm.*recovery.*email|recovery.*email/i.test(bodyText);
              
              const allElements = Array.from(document.querySelectorAll('*'));
              const recoveryElements = allElements.filter(el => {
                const text = (el.textContent || '').toLowerCase().trim();
                const style = window.getComputedStyle(el);
                return (/confirm.*recovery.*email|recovery.*email/i.test(text) && 
                        text.length < 200 &&
                        style.display !== 'none' && 
                        style.visibility !== 'hidden' &&
                        style.opacity !== '0');
              });
              
              return hasText || recoveryElements.length > 0;
            });
            
            if (hasRecoveryOption) {
              console.log(`✓ Found recovery email option on attempt ${attempt + 1}`);
              await this.handleRecoveryEmailVerification(page, profile);
              await HumanEmulation.randomDelay(2000, 3000);
              break;
            }
            
            if (attempt === 4) {
              console.log('No recovery email option found after 5 attempts');
            }
          }
          
          await HumanEmulation.randomDelay(2000, 3000);
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

      // Check for CAPTCHA before other challenges
      await this.handleCaptcha(page);
      
      // Check for recovery email selection screen
      await this.handleRecoveryEmailSelection(page, profile);
      
      // Check again for "Verify it's you" screen with recovery email confirmation option (in case it appeared later)
      await this.handleRecoveryEmailVerification(page, profile);
      
      // Check for phone number prompt (SMS verification)
      const phoneNumberPrompt = await page.evaluate(() => {
        const bodyText = document.body.textContent.toLowerCase();
        const url = window.location.href.toLowerCase();
        
        // Check for phone number prompts
        const hasPhonePrompt = /enter.*phone.*number|phone.*number.*text.*message|verification.*code.*phone/i.test(bodyText);
        
        // Check for phone input fields
        const phoneInputs = Array.from(document.querySelectorAll('input')).filter(input => {
          const type = input.type.toLowerCase();
          const name = (input.name || '').toLowerCase();
          const id = (input.id || '').toLowerCase();
          const label = (input.getAttribute('aria-label') || '').toLowerCase();
          const placeholder = (input.placeholder || '').toLowerCase();
          return type === 'tel' || 
                 name.includes('phone') || 
                 id.includes('phone') || 
                 label.includes('phone') ||
                 placeholder.includes('phone');
        });
        
        // Check URL for phone/challenge indicators
        const isPhoneChallenge = url.includes('challenge') && (hasPhonePrompt || phoneInputs.length > 0);
        
        return {
          hasPhonePrompt,
          phoneInputCount: phoneInputs.length,
          isPhoneChallenge,
          url
        };
      });
      
      if (phoneNumberPrompt.hasPhonePrompt || phoneNumberPrompt.phoneInputCount > 0) {
        console.log('Phone number prompt detected - attempting SMS verification...');
        console.log(`  - Has phone prompt text: ${phoneNumberPrompt.hasPhonePrompt}`);
        console.log(`  - Phone input fields found: ${phoneNumberPrompt.phoneInputCount}`);
        
        try {
          await this.handleSMSVerification(page);
        } catch (smsError) {
          console.log('SMS verification failed:', smsError.message);
          console.log('Checking for alternative verification methods...');
          await this.tryAlternativeVerification(page);
        }
        
        await HumanEmulation.randomDelay(3000, 5000);
      }
      
      console.log('=== handleLogin COMPLETED SUCCESSFULLY ===');
      
      // Wait a bit for any navigation to complete
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Check for other verification challenges (with error handling for navigation)
      let verifyChallenge = false;
      try {
        verifyChallenge = await page.evaluate(() => {
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
      } catch (evalError) {
        // Handle "Execution context was destroyed" error (page navigated)
        if (evalError.message.includes('Execution context was destroyed') || 
            evalError.message.includes('navigation')) {
          console.log('Page navigated after login (this is normal)');
          verifyChallenge = false; // Assume no challenge if page navigated
        } else {
          throw evalError; // Re-throw other errors
        }
      }
      
      let smsVerificationAttempted = false;
      if (verifyChallenge && !phoneNumberPrompt.hasPhonePrompt) {
        console.log('Other verification challenge detected');
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
      
      // Find and click the "Confirm your recovery email" option using Puppeteer directly
      console.log('Attempting to find and click "Confirm your recovery email" option...');
      
      let optionClicked = false;
      
      // Try multiple selectors and text patterns
      const selectors = [
        'button:has-text("Confirm your recovery email")',
        'a:has-text("Confirm your recovery email")',
        '[role="button"]:has-text("Confirm your recovery email")',
        '[role="option"]:has-text("Confirm your recovery email")'
      ];
      
      // First, try to find using text content with Puppeteer
      try {
        const recoveryOption = await page.evaluateHandle(() => {
          const allElements = Array.from(document.querySelectorAll('button, a, div, span, [role="button"], [role="option"], li'));
          
          // Priority 1: Exact match for "Confirm your recovery email" - MUST exclude phone/computer options
          for (const el of allElements) {
            const text = (el.textContent || '').toLowerCase().trim();
            // Must contain "confirm" AND "recovery" AND "email", but NOT "phone" or "computer"
            if (/confirm.*recovery.*email/i.test(text) && 
                !/phone|computer|another.*device/i.test(text) && 
                text.length < 150) {
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                return el;
              }
            }
          }
          
          // Priority 2: "Confirm recovery email" (without "your")
          for (const el of allElements) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (/confirm.*recovery.*email/i.test(text) && 
                !/phone|computer|another.*device|use.*another/i.test(text) && 
                text.length > 15 && text.length < 200) {
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                // Find clickable parent
                let clickable = el;
                for (let i = 0; i < 5; i++) {
                  if (clickable.tagName === 'BUTTON' || clickable.tagName === 'A' || 
                      clickable.getAttribute('role') === 'button' || 
                      clickable.getAttribute('role') === 'option' ||
                      clickable.onclick !== null) {
                    return clickable;
                  }
                  clickable = clickable.parentElement;
                  if (!clickable || clickable === document.body) break;
                }
                return el;
              }
            }
          }
          
          // Priority 3: Just "recovery email" but MUST exclude phone/computer options
          for (const el of allElements) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (/recovery.*email/i.test(text) && 
                !/phone|computer|another.*device|use.*another|verification.*code/i.test(text) && 
                text.length > 10 && text.length < 200) {
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                // Find clickable parent
                let clickable = el;
                for (let i = 0; i < 5; i++) {
                  if (clickable.tagName === 'BUTTON' || clickable.tagName === 'A' || 
                      clickable.getAttribute('role') === 'button' || 
                      clickable.getAttribute('role') === 'option' ||
                      clickable.onclick !== null) {
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
          const element = recoveryOption.asElement();
          await element.scrollIntoView();
          await HumanEmulation.randomDelay(300, 500);
          await element.click();
          console.log('✓ Clicked "Confirm your recovery email" option using Puppeteer');
          optionClicked = true;
          await HumanEmulation.randomDelay(2000, 3000);
        }
      } catch (puppeteerError) {
        console.log('Puppeteer click failed:', puppeteerError.message);
      }
      
      // Fallback: Try evaluate click
      if (!optionClicked) {
        const evalResult = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('button, a, div, span, [role="button"], [role="option"], li'));
          
          // Priority: "Confirm your recovery email" - exclude phone/computer options
          for (const el of allElements) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (/confirm.*recovery.*email/i.test(text) && 
                !/phone|computer|another.*device|use.*another/i.test(text) && 
                text.length < 200) {
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                try {
                  el.scrollIntoView({ block: 'center' });
                  el.click();
                  return { success: true };
                } catch (e) {
                  // Try parent
                  let clickable = el.parentElement;
                  for (let i = 0; i < 3; i++) {
                    if (clickable && clickable !== document.body) {
                      try {
                        clickable.scrollIntoView({ block: 'center' });
                        clickable.click();
                        return { success: true };
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
        
        if (evalResult && evalResult.success) {
          console.log('✓ Clicked "Confirm your recovery email" option using evaluate');
          optionClicked = true;
          await HumanEmulation.randomDelay(2000, 3000);
        }
      }
      
      // If evaluate click didn't work, try using Puppeteer's click method
      if (!optionClicked || !optionClicked.success) {
        console.log('Evaluate click failed, trying Puppeteer click method...');
        
        // Find the element using Puppeteer
        const recoveryOption = await page.evaluateHandle(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
          
          // Priority 1: Exact "Confirm your recovery email" - exclude phone/computer
          for (const el of allElements) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (/confirm.*recovery.*email/i.test(text) && 
                !/phone|computer|another.*device|use.*another/i.test(text) && 
                text.length < 100) {
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                return el;
              }
            }
          }
          
          // Priority 2: "recovery email" but MUST exclude phone/computer/verification code options
          for (const el of allElements) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (/recovery.*email/i.test(text) && 
                !/phone|computer|another.*device|use.*another|verification.*code|get.*code/i.test(text) && 
                text.length > 10 && text.length < 150) {
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
          
          // Check if Google is asking for phone number after recovery email
          const needsPhoneNumber = await page.evaluate(() => {
            const bodyText = document.body.textContent.toLowerCase();
            const hasPhonePrompt = /phone.*number|recovery.*phone|verify.*phone|enter.*phone/i.test(bodyText);
            
            // Check for phone input fields
            const phoneInputs = Array.from(document.querySelectorAll('input')).filter(input => {
              const type = input.type.toLowerCase();
              const name = (input.name || '').toLowerCase();
              const id = (input.id || '').toLowerCase();
              const label = (input.getAttribute('aria-label') || '').toLowerCase();
              return type === 'tel' || name.includes('phone') || id.includes('phone') || label.includes('phone');
            });
            
            return hasPhonePrompt || phoneInputs.length > 0;
          });
          
          if (needsPhoneNumber) {
            console.log('Phone number required after recovery email - attempting SMS verification...');
            try {
              await this.handleSMSVerification(page);
              await HumanEmulation.randomDelay(3000, 5000);
            } catch (smsError) {
              console.log('SMS verification after recovery email failed:', smsError.message);
              console.log('Attempting alternative verification methods...');
              await this.tryAlternativeVerification(page);
            }
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

  async handleCaptcha(page) {
    try {
      console.log('Checking for CAPTCHA...');
      
      if (!this.capmonster.apiKey) {
        console.log('CapMonster API key not configured, skipping CAPTCHA solving');
        console.log('Please configure CAPMONSTER_API_KEY in .env file to enable CAPTCHA solving');
        return;
      }

      // Check if CAPTCHA is already solved/validated
      const alreadySolved = await page.evaluate(() => {
        const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
        if (textarea && textarea.value && textarea.value.length > 100) {
          // Check if it's a valid token (starts with certain patterns)
          const token = textarea.value;
          if (token.length > 100 && !token.includes('undefined') && !token.includes('null')) {
            return true;
          }
        }
        return false;
      });

      if (alreadySolved) {
        console.log('CAPTCHA already has a solution token, skipping...');
        return;
      }

      await HumanEmulation.randomDelay(2000, 3000);

      // Wait for reCAPTCHA to load if present
      try {
        await page.waitForSelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey], .g-recaptcha', { 
          timeout: 5000 
        }).catch(() => {});
      } catch (e) {}

      // Note: We'll inject the token first, then update the checkbox to show as verified

      // Don't click the checkbox - let CapMonster solve it first, then we'll inject the solution
      // Clicking it manually might interfere with CapMonster's solving process

      const captchaInfo = await page.evaluate(() => {
        const bodyText = document.body.textContent.toLowerCase();
        const hasCaptcha = /captcha|verify.*human|i.*not.*robot/i.test(bodyText);
        
        if (!hasCaptcha) {
          return null;
        }

        const siteKey = (() => {
          // Method 1: Check window.grecaptcha object (most reliable for Google)
          if (window.grecaptcha && window.grecaptcha.ready) {
            try {
              const widgets = document.querySelectorAll('[data-sitekey]');
              if (widgets.length > 0) {
                const key = widgets[0].getAttribute('data-sitekey');
                if (key) return key;
              }
            } catch (e) {}
          }

          // Method 2: Check all elements with data-sitekey attribute
          const recaptchaDivs = Array.from(document.querySelectorAll('[data-sitekey]'));
          for (const div of recaptchaDivs) {
            const key = div.getAttribute('data-sitekey');
            if (key && key.length > 10) {
              return key;
            }
          }

          // Method 3: Check iframes - look in src, name, and id attributes
          const iframes = Array.from(document.querySelectorAll('iframe'));
          for (const iframe of iframes) {
            // Check src attribute
            const src = iframe.src || '';
            if (src.includes('recaptcha') || src.includes('hcaptcha')) {
              // Try to extract from URL parameters
              const urlParams = new URLSearchParams(src.split('?')[1] || '');
              const sitekeyParam = urlParams.get('sitekey') || urlParams.get('data-sitekey') || urlParams.get('k');
              if (sitekeyParam) {
                return decodeURIComponent(sitekeyParam);
              }
              
              // Try regex match on URL
              const siteKeyMatch = src.match(/[?&](?:sitekey|data-sitekey|site-key|k)=([^&]+)/i);
              if (siteKeyMatch) {
                return decodeURIComponent(siteKeyMatch[1]);
              }
            }
            
            // Check name attribute (sometimes contains site key)
            const name = iframe.name || '';
            if (name.length > 20 && /^[a-zA-Z0-9_-]+$/.test(name)) {
              return name;
            }
          }

          // Method 4: Check all scripts for site key patterns
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const script of scripts) {
            const content = script.textContent || script.innerHTML || '';
            
            // Look for data-sitekey in script content
            const patterns = [
              /data-sitekey\s*=\s*["']([^"']+)["']/i,
              /sitekey\s*[:=]\s*["']([^"']+)["']/i,
              /sitekey["']?\s*:\s*["']([^"']+)["']/i,
              /["']sitekey["']\s*:\s*["']([^"']+)["']/i,
              /render\s*=\s*["']([^"']+)["']/i, // reCAPTCHA v3 render parameter
            ];
            
            for (const pattern of patterns) {
              const match = content.match(pattern);
              if (match && match[1] && match[1].length > 10) {
                return match[1];
              }
            }
          }

          // Method 5: Check script src attributes for render parameter (reCAPTCHA v3)
          const scriptTags = Array.from(document.querySelectorAll('script[src*="recaptcha"]'));
          for (const script of scriptTags) {
            const src = script.src || '';
            const renderMatch = src.match(/render=([^&]+)/i);
            if (renderMatch) {
              return decodeURIComponent(renderMatch[1]);
            }
          }

          // Method 6: Check for Google's standard reCAPTCHA site keys in page HTML
          const htmlContent = document.documentElement.outerHTML;
          const htmlPatterns = [
            /data-sitekey=["']([^"']{20,})["']/i,
            /sitekey["']?\s*[:=]\s*["']([^"']{20,})["']/i,
          ];
          
          for (const pattern of htmlPatterns) {
            const matches = htmlContent.matchAll(new RegExp(pattern.source, 'gi'));
            for (const match of matches) {
              if (match[1] && match[1].length > 10) {
                return match[1];
              }
            }
          }

          // Method 7: Try to get from grecaptcha widget if available
          if (window.grecaptcha && typeof window.grecaptcha.execute === 'function') {
            try {
              const widgets = document.querySelectorAll('.g-recaptcha, [id^="recaptcha"]');
              for (const widget of widgets) {
                const widgetId = widget.id;
                if (widgetId) {
                  const response = window.grecaptcha.getResponse();
                  if (response) {
                    // If we can get response, try to find the site key from widget
                    const parent = widget.closest('[data-sitekey]') || widget.parentElement;
                    if (parent) {
                      const key = parent.getAttribute('data-sitekey');
                      if (key) return key;
                    }
                  }
                }
              }
            } catch (e) {}
          }

          return null;
        })();

        const captchaType = (() => {
          // Check for hCaptcha first
          if (document.querySelector('iframe[src*="hcaptcha"]')) {
            return 'hcaptcha';
          }
          
          // Check for reCAPTCHA
          const hasRecaptchaIframe = document.querySelector('iframe[src*="recaptcha"]');
          const hasDataSitekey = document.querySelector('[data-sitekey]');
          
          if (hasRecaptchaIframe || hasDataSitekey) {
            // reCAPTCHA v3 uses render parameter and is invisible
            const v3Indicator = document.querySelector('script[src*="recaptcha/api.js?render"]');
            
            // reCAPTCHA v2 has visible checkbox
            const hasCheckbox = document.querySelector('.recaptcha-checkbox, .recaptcha-checkbox-border, iframe[title*="recaptcha"], iframe[title*="robot"]');
            const hasCheckboxText = /i.*not.*robot|verify.*robot/i.test(document.body.textContent);
            
            // If there's a visible checkbox or checkbox text, it's v2
            if (hasCheckbox || hasCheckboxText) {
              return 'recaptcha-v2';
            }
            
            // If there's a render script, it's v3
            if (v3Indicator) {
              return 'recaptcha-v3';
            }
            
            // Default to v2 for Google verification pages (most common)
            if (window.location.href.includes('accounts.google.com') || 
                window.location.href.includes('google.com')) {
              return 'recaptcha-v2';
            }
            
            // Default to v2 as it's more common
            return 'recaptcha-v2';
          }
          
          return 'unknown';
        })();

        return {
          hasCaptcha,
          siteKey,
          captchaType,
          currentUrl: window.location.href
        };
      });

      if (!captchaInfo || !captchaInfo.hasCaptcha) {
        console.log('No CAPTCHA detected');
        return;
      }

      if (!captchaInfo.siteKey || captchaInfo.siteKey === 'explicit' || captchaInfo.siteKey.length < 20) {
        if (captchaInfo.siteKey === 'explicit' || (captchaInfo.siteKey && captchaInfo.siteKey.length < 20)) {
          console.log(`⚠ Invalid site key detected: "${captchaInfo.siteKey}"`);
          console.log('This might be a different type of challenge (not reCAPTCHA) or the site key extraction failed.');
          console.log('Skipping CAPTCHA solving - this challenge may need manual handling.');
          return;
        }
        console.log('CAPTCHA detected but site key not found');
        console.log('Attempting to find site key with additional methods...');
        
        // Try waiting a bit more for dynamic content to load
        await HumanEmulation.randomDelay(3000, 5000);
        
        // Try again with more detailed extraction
        const detailedCaptchaInfo = await page.evaluate(() => {
          const debugInfo = {
            hasRecaptchaIframe: !!document.querySelector('iframe[src*="recaptcha"]'),
            hasHcaptchaIframe: !!document.querySelector('iframe[src*="hcaptcha"]'),
            hasDataSitekey: document.querySelectorAll('[data-sitekey]').length,
            hasGrecaptcha: !!(window.grecaptcha),
            allIframes: Array.from(document.querySelectorAll('iframe')).map(iframe => ({
              src: iframe.src.substring(0, 200),
              name: iframe.name,
              id: iframe.id
            })),
            allDataSitekeys: Array.from(document.querySelectorAll('[data-sitekey]')).map(el => ({
              key: el.getAttribute('data-sitekey'),
              tag: el.tagName,
              id: el.id
            }))
          };
          
          // Try one more time with iframe content access
          const iframes = Array.from(document.querySelectorAll('iframe[src*="recaptcha"]'));
          for (const iframe of iframes) {
            try {
              const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
              if (iframeDoc) {
                const sitekeyEl = iframeDoc.querySelector('[data-sitekey]');
                if (sitekeyEl) {
                  return {
                    siteKey: sitekeyEl.getAttribute('data-sitekey'),
                    debugInfo
                  };
                }
              }
            } catch (e) {
              // Cross-origin, can't access
            }
          }
          
          return { siteKey: null, debugInfo };
        });
        
        if (detailedCaptchaInfo.siteKey) {
          console.log('✓ Found site key with detailed extraction:', detailedCaptchaInfo.siteKey.substring(0, 20) + '...');
          captchaInfo.siteKey = detailedCaptchaInfo.siteKey;
        } else {
          console.log('✗ Still could not find site key. Debug info:', JSON.stringify(detailedCaptchaInfo.debugInfo, null, 2));
          
          // Last resort: Try to extract from the reCAPTCHA widget's internal state
          const widgetSiteKey = await page.evaluate(() => {
            // Check if grecaptcha is available and has widgets
            if (window.grecaptcha) {
              try {
                // Try to get widget IDs
                const widgets = document.querySelectorAll('[data-sitekey], .g-recaptcha');
                for (const widget of widgets) {
                  const widgetId = widget.getAttribute('data-widget-id') || widget.id;
                  if (widgetId) {
                    try {
                      // Try to get response which might reveal site key
                      const response = window.grecaptcha.getResponse(widgetId);
                      // Check parent for site key
                      const parent = widget.closest('[data-sitekey]') || widget.parentElement;
                      if (parent) {
                        const key = parent.getAttribute('data-sitekey');
                        if (key) return key;
                      }
                    } catch (e) {}
                  }
                }
                
                // Try to find in all possible locations one more time
                const allPossibleKeys = [];
                document.querySelectorAll('*').forEach(el => {
                  const attrs = ['data-sitekey', 'sitekey', 'data-key', 'key'];
                  attrs.forEach(attr => {
                    const val = el.getAttribute(attr);
                    if (val && val.length > 20 && /^[a-zA-Z0-9_-]+$/.test(val)) {
                      allPossibleKeys.push(val);
                    }
                  });
                });
                
                if (allPossibleKeys.length > 0) {
                  return allPossibleKeys[0];
                }
              } catch (e) {}
            }
            return null;
          });
          
          if (widgetSiteKey) {
            console.log('✓ Found site key from widget state:', widgetSiteKey.substring(0, 20) + '...');
            captchaInfo.siteKey = widgetSiteKey;
          } else {
            console.log('You may need to complete CAPTCHA manually or check if it\'s a different CAPTCHA type');
            console.log('Tip: Check browser console for reCAPTCHA-related errors or site key in network requests');
            return;
          }
        }
      }

      // Validate site key before attempting to solve
      if (!captchaInfo.siteKey || captchaInfo.siteKey.length < 20 || 
          captchaInfo.siteKey === 'explicit' || 
          captchaInfo.siteKey.toLowerCase().includes('explicit')) {
        console.log(`⚠ Invalid CAPTCHA site key detected: "${captchaInfo.siteKey}"`);
        console.log('This is not a valid reCAPTCHA/hCaptcha site key.');
        console.log('This might be a different type of challenge that cannot be solved automatically.');
        console.log('Skipping CAPTCHA solving - manual intervention may be required.');
        return;
      }

      console.log(`CAPTCHA detected: ${captchaInfo.captchaType}, Site Key: ${captchaInfo.siteKey.substring(0, 20)}...`);

      let solution = null;
      try {
        console.log(`Attempting to solve ${captchaInfo.captchaType}...`);
        
        if (captchaInfo.captchaType === 'recaptcha-v2') {
          solution = await this.capmonster.solveReCaptchaV2(captchaInfo.currentUrl, captchaInfo.siteKey);
        } else if (captchaInfo.captchaType === 'recaptcha-v3') {
          console.log('Note: reCAPTCHA v3 may take longer to solve (up to 5 minutes). Please wait...');
          solution = await this.capmonster.solveReCaptchaV3(captchaInfo.currentUrl, captchaInfo.siteKey, 'verify');
        } else if (captchaInfo.captchaType === 'hcaptcha') {
          solution = await this.capmonster.solveHCaptcha(captchaInfo.currentUrl, captchaInfo.siteKey);
        } else {
          console.log('Unknown CAPTCHA type, trying reCAPTCHA v2 (most common)...');
          // Validate site key again before attempting
          if (captchaInfo.siteKey && captchaInfo.siteKey.length >= 20 && 
              captchaInfo.siteKey !== 'explicit' && 
              !captchaInfo.siteKey.toLowerCase().includes('explicit')) {
            solution = await this.capmonster.solveReCaptchaV2(captchaInfo.currentUrl, captchaInfo.siteKey);
          } else {
            throw new Error('Invalid site key for CAPTCHA solving');
          }
        }
      } catch (solveError) {
        console.error('Failed to solve CAPTCHA:', solveError.message);
        
        // If v3 failed or timed out, try v2 as fallback (sometimes detection is wrong)
        if (captchaInfo.captchaType === 'recaptcha-v3') {
          console.log('reCAPTCHA v3 solving failed or timed out, trying v2 as fallback...');
          console.log('Note: Google verification pages usually use reCAPTCHA v2 (checkbox)');
          try {
            solution = await this.capmonster.solveReCaptchaV2(captchaInfo.currentUrl, captchaInfo.siteKey);
            console.log('✓ Fallback to v2 succeeded!');
          } catch (fallbackError) {
            console.error('Fallback to v2 also failed:', fallbackError.message);
            return;
          }
        } else {
          return;
        }
      }

      if (!solution) {
        console.log('CAPTCHA solution not received');
        return;
      }

      console.log('CAPTCHA solved! Solution token received.');
      console.log('Token length:', solution ? solution.length : 0);
      console.log('Injecting solution into page...');

      // Wait a bit to ensure the page is ready
      await HumanEmulation.randomDelay(1000, 2000);

      const injected = await page.evaluate((solution, siteKey) => {
        console.log('Attempting to inject CAPTCHA solution...');
        console.log('Solution length:', solution ? solution.length : 0);
        console.log('Site key:', siteKey ? siteKey.substring(0, 20) + '...' : 'none');
        
        // Method 1: Use grecaptcha API to set the response (most reliable)
        if (window.grecaptcha) {
          try {
            // Find all widgets
            const widgets = document.querySelectorAll('[data-sitekey], .g-recaptcha, [id^="recaptcha"]');
            
            for (const widget of widgets) {
              try {
                let widgetId = widget.getAttribute('data-widget-id');
                
                // If no widget ID, try to find it by checking grecaptcha's internal state
                if (!widgetId) {
                  // Try to get widget ID from grecaptcha
                  try {
                    if (typeof window.grecaptcha.getResponse === 'function') {
                      // Try widget ID 0, 1, 2, etc.
                      for (let i = 0; i < 10; i++) {
                        try {
                          const response = window.grecaptcha.getResponse(i);
                          if (response !== '') {
                            widgetId = i.toString();
                            break;
                          }
                        } catch (e) {}
                      }
                    }
                  } catch (e) {}
                  
                  // Fallback: try to extract from widget ID attribute or element ID
                  widgetId = widget.id?.replace('recaptcha-', '') || 
                            widget.querySelector('[data-widget-id]')?.getAttribute('data-widget-id');
                }
                
                if (widgetId !== null && widgetId !== undefined) {
                  const widgetIdNum = parseInt(widgetId);
                  
                  // CRITICAL: Set the response using grecaptcha's internal mechanism
                  // We need to directly manipulate grecaptcha's internal state
                  try {
                    // Method 1: Try to set response via grecaptcha's internal API
                    // This is the key - we need to set it in grecaptcha's state, not just the textarea
                    if (window.grecaptcha && window.grecaptcha.enterprise) {
                      // For Enterprise reCAPTCHA
                      if (window.grecaptcha.enterprise.execute) {
                        window.grecaptcha.enterprise.execute(widgetIdNum, { action: 'verify' });
                      }
                    }
                    
                    // Method 2: Directly set the response in grecaptcha's internal storage
                    // Access grecaptcha's internal widget data
                    if (window.grecaptcha && window.grecaptcha._widgets) {
                      const widgetData = window.grecaptcha._widgets[widgetIdNum];
                      if (widgetData) {
                        // CRITICAL: Set the response in the widget's internal state
                        widgetData.response = solution;
                        
                        // Mark checkbox as checked to show Google it's validated
                        if (widgetData.$checkbox) {
                          widgetData.$checkbox.setAttribute('aria-checked', 'true');
                          widgetData.$checkbox.classList.add('recaptcha-checkbox-checked');
                          widgetData.$checkbox.classList.add('recaptcha-checkbox-checkmark');
                        }
                        
                        // Also update the iframe if it exists
                        if (widgetData.$iframe) {
                          widgetData.$iframe.setAttribute('title', 'reCAPTCHA verified');
                        }
                        
                        // Trigger the callback if it exists
                        if (widgetData.callback && typeof widgetData.callback === 'function') {
                          try {
                            widgetData.callback(solution);
                          } catch (e) {
                            console.log('Widget callback error:', e.message);
                          }
                        }
                      } else {
                        // Widget not found in _widgets, try to create/update it
                        if (!window.grecaptcha._widgets[widgetIdNum]) {
                          window.grecaptcha._widgets[widgetIdNum] = { response: solution };
                        } else {
                          window.grecaptcha._widgets[widgetIdNum].response = solution;
                        }
                      }
                    }
                    
                    // Method 3: Set via textarea AND trigger grecaptcha events
                    const textarea = widget.querySelector('textarea[name="g-recaptcha-response"]') ||
                                   document.querySelector(`textarea[name="g-recaptcha-response"]`);
                    
                    if (textarea) {
                      // Set the value
                      textarea.value = solution;
                      
                      // CRITICAL: Trigger grecaptcha's internal update mechanism
                      // Dispatch a custom event that grecaptcha listens to
                      const inputEvent = new Event('input', { bubbles: true, cancelable: true });
                      textarea.dispatchEvent(inputEvent);
                      
                      const changeEvent = new Event('change', { bubbles: true, cancelable: true });
                      textarea.dispatchEvent(changeEvent);
                      
                      // Try to trigger grecaptcha's response update
                      if (typeof window.grecaptcha.getResponse === 'function') {
                        // Force grecaptcha to recognize the new response
                        try {
                          // Access grecaptcha's internal state and update it
                          if (window.grecaptcha._widgets && window.grecaptcha._widgets[widgetIdNum]) {
                            window.grecaptcha._widgets[widgetIdNum].response = solution;
                            // Mark as verified
                            if (window.grecaptcha._widgets[widgetIdNum].$checkbox) {
                              window.grecaptcha._widgets[widgetIdNum].$checkbox.setAttribute('aria-checked', 'true');
                              window.grecaptcha._widgets[widgetIdNum].$checkbox.classList.add('recaptcha-checkbox-checked');
                            }
                          }
                        } catch (e) {
                          console.log('Internal state update error:', e.message);
                        }
                      }
                      
                      console.log('✓ Solution set via grecaptcha widget (ID: ' + widgetId + ')');
                      return { success: true, method: 'grecaptcha-widget-internal', widgetId };
                    }
                  } catch (e) {
                    console.log('grecaptcha API error:', e.message);
                  }
                }
              } catch (e) {
                console.log('Widget processing error:', e.message);
              }
            }
            
            // If no widget ID found, try to find textarea and set it
            const allTextareas = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
            if (allTextareas.length > 0) {
              for (const ta of allTextareas) {
                ta.value = solution;
                
                ['input', 'change', 'keyup', 'blur'].forEach(eventType => {
                  const event = new Event(eventType, { bubbles: true, cancelable: true });
                  ta.dispatchEvent(event);
                });
              }
              
              // CRITICAL: Try to find and update the checkbox directly
              // Search for checkbox in various ways
              const checkboxSelectors = [
                '.recaptcha-checkbox',
                '.recaptcha-checkbox-border',
                '[role="checkbox"]',
                'div[class*="recaptcha-checkbox"]',
                'span[class*="recaptcha-checkbox"]'
              ];
              
              let checkboxFound = false;
              for (const selector of checkboxSelectors) {
                const checkboxes = document.querySelectorAll(selector);
                for (const cb of checkboxes) {
                  try {
                    // Mark as checked
                    cb.setAttribute('aria-checked', 'true');
                    cb.classList.add('recaptcha-checkbox-checked');
                    cb.classList.add('recaptcha-checkbox-checkmark');
                    
                    // Also try to find parent and mark it
                    const parent = cb.closest('div, span');
                    if (parent) {
                      parent.classList.add('recaptcha-checkbox-checked');
                      parent.setAttribute('aria-checked', 'true');
                    }
                    
                    checkboxFound = true;
                  } catch (e) {}
                }
              }
              
              // Also try to update grecaptcha's internal state if accessible
              if (window.grecaptcha && window.grecaptcha._widgets) {
                // Try all widget IDs
                for (let i = 0; i < 10; i++) {
                  try {
                    if (window.grecaptcha._widgets[i]) {
                      window.grecaptcha._widgets[i].response = solution;
                      if (window.grecaptcha._widgets[i].$checkbox) {
                        window.grecaptcha._widgets[i].$checkbox.setAttribute('aria-checked', 'true');
                        window.grecaptcha._widgets[i].$checkbox.classList.add('recaptcha-checkbox-checked');
                      }
                    }
                  } catch (e) {}
                }
              }
              
              console.log('✓ Solution set via all textareas' + (checkboxFound ? ' and checkbox updated' : ''));
              return { success: true, method: 'all-textareas', checkboxUpdated: checkboxFound };
            }
          } catch (e) {
            console.log('grecaptcha API error:', e.message);
          }
        }

        // Method 2: Direct textarea injection (fallback)
        const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
        if (textarea) {
          textarea.value = solution;
          
          // Trigger multiple events
          ['input', 'change', 'keyup', 'blur', 'focus'].forEach(eventType => {
            const event = new Event(eventType, { bubbles: true, cancelable: true });
            textarea.dispatchEvent(event);
          });
          
          // Try to set via different methods
          try {
            textarea.setAttribute('value', solution);
            Object.defineProperty(textarea, 'value', { value: solution, writable: true });
          } catch (e) {}
          
          console.log('✓ Solution set via direct textarea');
          return { success: true, method: 'direct-textarea' };
        }

        // Method 3: Hidden input
        const hiddenInput = document.querySelector(`input[name="g-recaptcha-response"]`);
        if (hiddenInput) {
          hiddenInput.value = solution;
          ['input', 'change'].forEach(eventType => {
            const event = new Event(eventType, { bubbles: true, cancelable: true });
            hiddenInput.dispatchEvent(event);
          });
          console.log('✓ Solution set via hidden input');
          return { success: true, method: 'hidden-input' };
        }

        // Method 4: Try to find by site key
        const recaptchaDiv = document.querySelector(`[data-sitekey="${siteKey}"]`);
        if (recaptchaDiv) {
          const ta = recaptchaDiv.querySelector('textarea[name="g-recaptcha-response"]');
          if (ta) {
            ta.value = solution;
            ['input', 'change'].forEach(eventType => {
              const event = new Event(eventType, { bubbles: true, cancelable: true });
              ta.dispatchEvent(event);
            });
            console.log('✓ Solution set via sitekey div');
            return { success: true, method: 'sitekey-div' };
          }
        }

        // Method 5: Search all textareas
        const allTextareas = Array.from(document.querySelectorAll('textarea'));
        for (const ta of allTextareas) {
          if (ta.name && ta.name.includes('recaptcha')) {
            ta.value = solution;
            ['input', 'change'].forEach(eventType => {
              const event = new Event(eventType, { bubbles: true, cancelable: true });
              ta.dispatchEvent(event);
            });
            console.log('✓ Solution set via found textarea');
            return { success: true, method: 'found-textarea' };
          }
        }

        console.log('✗ No injection target found');
        return { success: false, reason: 'no-target-found' };
      }, solution, captchaInfo.siteKey);

      if (injected && injected.success) {
        console.log(`✓ CAPTCHA solution injected using method: ${injected.method}`);
        await HumanEmulation.randomDelay(2000, 3000);

        // Verify the solution was set correctly
        const verifySolution = await page.evaluate(() => {
          const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
          if (textarea && textarea.value && textarea.value.length > 50) {
            return { verified: true, length: textarea.value.length };
          }
          return { verified: false };
        });

        if (verifySolution.verified) {
          console.log(`✓ Solution verified in DOM (length: ${verifySolution.length})`);
        } else {
          console.log('⚠ Solution may not be properly set, but continuing...');
        }

        // CRITICAL: Verify and force checkbox update if needed
        const checkboxStatus = await page.evaluate(() => {
          const checkbox = document.querySelector('.recaptcha-checkbox-checked, [aria-checked="true"]');
          if (!checkbox) {
            // Try to force update checkbox
            const checkboxes = document.querySelectorAll('.recaptcha-checkbox, .recaptcha-checkbox-border, [role="checkbox"]');
            for (const cb of checkboxes) {
              cb.setAttribute('aria-checked', 'true');
              cb.classList.add('recaptcha-checkbox-checked');
              cb.classList.add('recaptcha-checkbox-checkmark');
            }
            
            // Also try via grecaptcha
            if (window.grecaptcha && window.grecaptcha._widgets) {
              for (let i = 0; i < 10; i++) {
                if (window.grecaptcha._widgets[i] && window.grecaptcha._widgets[i].$checkbox) {
                  window.grecaptcha._widgets[i].$checkbox.setAttribute('aria-checked', 'true');
                  window.grecaptcha._widgets[i].$checkbox.classList.add('recaptcha-checkbox-checked');
                }
              }
            }
            
            return { wasChecked: false, updated: true };
          }
          return { wasChecked: true, updated: false };
        });

        if (checkboxStatus.wasChecked) {
          console.log('✓ reCAPTCHA checkbox is already checked');
        } else if (checkboxStatus.updated) {
          console.log('✓ Forced checkbox update - marked as checked');
        } else {
          console.log('⚠ Could not verify or update checkbox state via evaluate');
          
          // Last resort: Try using Puppeteer to click the checkbox directly
          try {
            const checkboxSelectors = [
              '.recaptcha-checkbox',
              '.recaptcha-checkbox-border',
              '[role="checkbox"]',
              'div[class*="recaptcha-checkbox"]'
            ];
            
            let clicked = false;
            for (const selector of checkboxSelectors) {
              try {
                const checkbox = await page.$(selector);
                if (checkbox) {
                  await checkbox.click({ delay: 100 });
                  console.log(`✓ Clicked checkbox via Puppeteer (${selector})`);
                  clicked = true;
                  await HumanEmulation.randomDelay(1000, 2000);
                  break;
                }
              } catch (e) {}
            }
            
            if (!clicked) {
              console.log('⚠ Could not find checkbox to click via Puppeteer');
            }
          } catch (e) {
            console.log('Puppeteer checkbox click error:', e.message);
          }
        }

        // Wait a bit for the token to be processed
        await HumanEmulation.randomDelay(2000, 3000);

        // Check if CAPTCHA is already validated (token accepted)
        const captchaValidated = await page.evaluate(() => {
          // Check if the reCAPTCHA widget shows as verified
          const checkbox = document.querySelector('.recaptcha-checkbox-checked, .recaptcha-checkbox-checkmark');
          const iframe = document.querySelector('iframe[src*="recaptcha"]');
          const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
          
          // If checkbox is checked and textarea has a long token, it might be validated
          if (checkbox && textarea && textarea.value && textarea.value.length > 100) {
            return true;
          }
          
          // Check if grecaptcha reports a response
          if (window.grecaptcha && typeof window.grecaptcha.getResponse === 'function') {
            try {
              const response = window.grecaptcha.getResponse();
              if (response && response.length > 100) {
                return true;
              }
            } catch (e) {}
          }
          
          return false;
        });

        if (captchaValidated) {
          console.log('✓ CAPTCHA appears to be validated');
        } else {
          console.log('⚠ CAPTCHA validation status unclear, proceeding with submission...');
        }

        // Critical: Wait for Google to process the token before submitting
        // Google needs time to validate the token on their servers
        console.log('Waiting for Google to validate the token...');
        await HumanEmulation.randomDelay(3000, 4000);

        // Try multiple methods to ensure the token is accepted
        // Method 1: Trigger grecaptcha callback if available
        const callbackTriggered = await page.evaluate((solution) => {
          if (window.grecaptcha) {
            try {
              // Find all widgets and trigger their callbacks
              const widgets = document.querySelectorAll('[data-sitekey]');
              let triggered = false;
              
              widgets.forEach(widget => {
                try {
                  const widgetId = widget.getAttribute('data-widget-id');
                  const callbackName = widget.getAttribute('data-callback');
                  
                  if (callbackName && window[callbackName]) {
                    window[callbackName](solution);
                    triggered = true;
                  }
                  
                  // Also try to set response via grecaptcha API
                  if (widgetId && typeof window.grecaptcha.getResponse === 'function') {
                    try {
                      const currentResponse = window.grecaptcha.getResponse(parseInt(widgetId));
                      if (!currentResponse || currentResponse.length < 100) {
                        // Try to execute to trigger validation
                        if (typeof window.grecaptcha.execute === 'function') {
                          window.grecaptcha.execute(parseInt(widgetId), { action: 'verify' });
                        }
                      }
                    } catch (e) {}
                  }
                } catch (e) {}
              });
              
              // Try global callback
              if (window.recaptchaCallback) {
                window.recaptchaCallback(solution);
                triggered = true;
              }
              
              return triggered;
            } catch (e) {
              console.log('Callback trigger error:', e.message);
              return false;
            }
          }
          return false;
        }, solution);

        if (callbackTriggered) {
          console.log('✓ Triggered grecaptcha callback');
        }

        // Wait a bit more for callback to process
        await HumanEmulation.randomDelay(2000, 3000);

        // Method 2: Check if checkbox shows as verified (indicates Google accepted token)
        const checkboxVerified = await page.evaluate(() => {
          const checkbox = document.querySelector('.recaptcha-checkbox-checked, .recaptcha-checkbox-checkmark, [aria-checked="true"]');
          const iframe = document.querySelector('iframe[title*="recaptcha"]');
          
          // Check if the iframe title indicates success
          if (iframe && iframe.title && iframe.title.includes('verified')) {
            return true;
          }
          
          return !!checkbox;
        });

        if (checkboxVerified) {
          console.log('✓ reCAPTCHA checkbox shows as verified');
        } else {
          console.log('⚠ reCAPTCHA checkbox not showing as verified - token may not be accepted yet');
        }

        // Method 3: Use Puppeteer to click the Next/Verify button (more reliable than evaluate)
        try {
          const nextButton = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"], div[role="button"]'));
            const submitBtn = buttons.find(btn => {
              const text = (btn.textContent || btn.value || btn.innerText || '').toLowerCase();
              const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
              const id = (btn.id || '').toLowerCase();
              return (/next|verify|continue|submit|confirm|done/i.test(text) || 
                      /next|verify|continue|submit|confirm|done/i.test(ariaLabel) ||
                      /next|verify|continue|submit/i.test(id)) &&
                     !/cancel|back|previous/i.test(text) &&
                     !/cancel|back|previous/i.test(ariaLabel);
            });
            
            if (submitBtn) {
              return {
                found: true,
                tag: submitBtn.tagName,
                id: submitBtn.id,
                text: submitBtn.textContent || submitBtn.value || submitBtn.innerText
              };
            }
            return { found: false };
          });

          if (nextButton.found) {
            console.log(`Found submit button: ${nextButton.tag}${nextButton.id ? '#' + nextButton.id : ''} - "${nextButton.text}"`);
            
            // Try to click using Puppeteer selector
            let clicked = false;
            if (nextButton.id) {
              try {
                await page.click(`#${nextButton.id}`, { delay: 100 });
                clicked = true;
                console.log('✓ Clicked button via ID selector');
              } catch (e) {}
            }
            
            if (!clicked) {
              // Try clicking by text content
              try {
                await page.evaluate(() => {
                  const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"], div[role="button"]'));
                  const submitBtn = buttons.find(btn => {
                    const text = (btn.textContent || btn.value || btn.innerText || '').toLowerCase();
                    return /next|verify|continue|submit|confirm|done/i.test(text) &&
                           !/cancel|back|previous/i.test(text);
                  });
                  if (submitBtn) {
                    submitBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    submitBtn.click();
                    return true;
                  }
                  return false;
                });
                clicked = true;
                console.log('✓ Clicked button via evaluate');
              } catch (e) {
                console.log('Button click error:', e.message);
              }
            }
          } else {
            console.log('⚠ Submit button not found');
          }
        } catch (e) {
          console.log('Error finding/clicking button:', e.message);
        }

        // Before submitting, verify the token will be sent correctly
        const tokenVerification = await page.evaluate(() => {
          const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
          const form = document.querySelector('form');
          
          return {
            hasToken: !!(textarea && textarea.value && textarea.value.length > 100),
            tokenLength: textarea ? textarea.value.length : 0,
            hasForm: !!form,
            formAction: form ? form.action : null,
            formMethod: form ? form.method : null
          };
        });

        console.log('Token verification before submission:', JSON.stringify(tokenVerification, null, 2));

        if (!tokenVerification.hasToken) {
          console.log('✗ ERROR: Token not found in form before submission!');
          console.log('This means the token was not properly injected or was cleared.');
          return;
        }

        // Wait for Google to process the token and navigate
        console.log('Waiting for Google to validate CAPTCHA token and navigate...');
        
        try {
          // Wait for either navigation away from CAPTCHA page OR for CAPTCHA challenge to disappear
          const navigationResult = await Promise.race([
            // Option 1: Wait for navigation
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).then(() => ({ type: 'navigation' })).catch(() => null),
            // Option 2: Wait for CAPTCHA to disappear
            page.waitForFunction(() => {
              const url = window.location.href;
              const hasCaptchaChallenge = document.querySelector('.recaptcha-challenge, iframe[src*="recaptcha/challenge"]');
              const isOnCaptchaPage = url.includes('/challenge/recaptcha');
              return !isOnCaptchaPage && !hasCaptchaChallenge;
            }, { timeout: 15000 }).then(() => ({ type: 'captcha-disappeared' })).catch(() => null),
            // Option 3: Wait for URL to change away from recaptcha
            page.waitForFunction(() => {
              const url = window.location.href;
              return !url.includes('/challenge/recaptcha') && !url.includes('recaptcha');
            }, { timeout: 15000 }).then(() => ({ type: 'url-changed' })).catch(() => null)
          ]);
          
          if (navigationResult) {
            console.log(`✓ CAPTCHA validated successfully - ${navigationResult.type}`);
          } else {
            // Check current status
            const currentStatus = await page.evaluate(() => {
              const url = window.location.href;
              const hasCaptcha = document.querySelector('iframe[src*="recaptcha"], .recaptcha-challenge');
              const isOnCaptchaPage = url.includes('/challenge/recaptcha');
              const checkbox = document.querySelector('.recaptcha-checkbox-checked');
              
              return {
                url: url.substring(0, 100),
                isOnCaptchaPage,
                hasCaptcha: !!hasCaptcha,
                checkboxChecked: !!checkbox
              };
            });
            
            if (!currentStatus.isOnCaptchaPage && !currentStatus.hasCaptcha) {
              console.log('✓ CAPTCHA appears to be validated (not on CAPTCHA page)');
            } else {
              console.log('⚠ Still on CAPTCHA page - token may not have been accepted');
              console.log('Current status:', JSON.stringify(currentStatus, null, 2));
              console.log('Possible reasons:');
              console.log('1. Token expired (took too long to submit) - reCAPTCHA tokens expire quickly');
              console.log('2. Token was rejected by Google - server-side validation failed');
              console.log('3. Google detected automation - anti-bot measures');
              console.log('4. Token format/validation issue - CapMonster token not compatible');
              console.log('');
              console.log('⚠ IMPORTANT: Google may be rejecting programmatically injected tokens.');
              console.log('This is a known limitation when using CAPTCHA solving services.');
              console.log('Possible solutions:');
              console.log('- Use residential proxies to avoid detection');
              console.log('- Add more human-like delays and interactions');
              console.log('- Try a different CAPTCHA solving service');
              console.log('- Consider using browser automation that mimics human behavior more closely');
              
              // Try waiting a bit more and checking again
              await HumanEmulation.randomDelay(3000, 5000);
              const finalCheck = await page.evaluate(() => {
                return !window.location.href.includes('/challenge/recaptcha');
              });
              
              if (finalCheck) {
                console.log('✓ CAPTCHA validated after additional wait');
              } else {
                console.log('✗ CAPTCHA still not validated after extended wait');
              }
            }
          }
        } catch (navError) {
          console.log('Navigation/timeout after CAPTCHA submission');
          console.log('Error:', navError.message);
          console.log('⚠ CAPTCHA solving may have failed. Check the browser window.');
        }
      } else {
        console.log('✗ Failed to inject CAPTCHA solution');
        console.log('Injection result:', injected);
        console.log('');
        console.log('⚠ CAPTCHA injection failed. You may need to complete CAPTCHA manually.');
        console.log('The browser window should still be open for manual intervention.');
      }
    } catch (error) {
      console.error('CAPTCHA handling error:', error.message);
      console.error('');
      console.error('⚠ CAPTCHA solving encountered an error.');
      console.error('The automation will continue, but CAPTCHA may need manual solving.');
    }
    
    // Return a status indicator so calling code knows if CAPTCHA was solved
    const captchaSolved = await page.evaluate(() => {
      return !window.location.href.includes('/challenge/recaptcha') && 
             !document.querySelector('iframe[src*="recaptcha"]');
    });
    
    return { solved: captchaSolved };
  }

  async handleSMSVerification(page) {
    try {
      console.log('SMS verification challenge detected, attempting to handle...');
      
      let orderId, number;
      
      // Check for manually rented phone number from environment variables
      const manualPhoneNumber = process.env.SMSPOOL_PHONE_NUMBER;
      const manualRentalId = process.env.SMSPOOL_RENTAL_ID;
      
      if (manualPhoneNumber) {
        console.log(`Using manually rented phone number: ${manualPhoneNumber}`);
        number = String(manualPhoneNumber || ''); // Ensure it's a string
        // Use phone number as identifier for SMS retrieval
        orderId = String(manualPhoneNumber).replace(/[^\d]/g, ''); // Remove non-digits for API
        console.log(`Will use phone number to retrieve SMS codes`);
      } else if (manualRentalId) {
        console.log(`Using rental ID: ${manualRentalId}`);
        orderId = String(manualRentalId || '');
        // Try to get phone number from rental if possible
        number = null; // Will be null, user can enter manually
      } else if (this.smspool.apiKey) {
        // Try to rent via API
        console.log('Attempting to rent phone number via SMSPool API...');
        const rentResult = await this.smspool.rentNumber('google');
        
        if (!rentResult || !rentResult.orderId || !rentResult.number) {
          console.log('Could not rent phone number from SMSPool API');
          console.log('SMS verification will need to be completed manually.');
          return;
        }
        
        orderId = rentResult.orderId;
        number = String(rentResult.number || ''); // Ensure number is always a string
        console.log(`✓ Rented phone number via API: ${number} (Order ID: ${orderId})`);
      } else {
        console.log('SMSPool API key not configured and no manual phone number provided');
        console.log('SMS verification will need to be completed manually.');
        return;
      }
      
      if (!number && !orderId) {
        console.log('⚠ No phone number or order ID available');
        return;
      }
      
      // CRITICAL: Ensure number is always a string for all operations (defensive conversion)
      // This prevents "number.replace is not a function" errors
      if (number != null) {
        number = String(number);
      } else {
        number = '';
      }
      
      // Also ensure orderId is a string
      if (orderId != null) {
        orderId = String(orderId);
      }
      
      console.log(`Using phone number: ${number || 'Will be entered manually'} (ID: ${orderId || 'N/A'})`);
      
      // Wait a bit for page to load
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Find phone input field - try multiple methods
      const phoneSelectors = [
        'input[type="tel"]',
        'input[name*="phone"]',
        'input[id*="phone"]',
        'input[aria-label*="phone" i]',
        'input[placeholder*="phone" i]',
        'input[placeholder*="Phone number" i]'
      ];
      
      let phoneInput = null;
      console.log('Searching for phone input field...');
      
      for (const selector of phoneSelectors) {
        try {
          phoneInput = await page.waitForSelector(selector, { timeout: 3000 });
          if (phoneInput) {
            console.log(`✓ Found phone input using selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      // Try finding by evaluate if not found
      if (!phoneInput) {
        console.log('Phone input not found with selectors, trying evaluate method...');
        const foundPhone = await page.evaluateHandle(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          return inputs.find(input => {
            const type = input.type.toLowerCase();
            const name = (input.name || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            const label = (input.getAttribute('aria-label') || '').toLowerCase();
            const placeholder = (input.placeholder || '').toLowerCase();
            const parentText = (input.closest('div, form, section')?.textContent || '').toLowerCase();
            
            // Check if it's a phone input
            const isPhoneInput = type === 'tel' || 
                                name.includes('phone') || 
                                id.includes('phone') || 
                                label.includes('phone') ||
                                placeholder.includes('phone') ||
                                (parentText.includes('phone') && (type === 'text' || type === ''));
            
            if (isPhoneInput) {
              const style = window.getComputedStyle(input);
              // Make sure it's visible
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                return input;
              }
            }
            return null;
          });
        });
        
        if (foundPhone && foundPhone.asElement()) {
          phoneInput = foundPhone.asElement();
          console.log('✓ Found phone input using evaluate method');
        }
      }
      
      // Last resort: find by context (near "Phone number" text)
      if (!phoneInput) {
        console.log('Trying to find phone input by context...');
        const contextPhone = await page.evaluateHandle(() => {
          // Find element with "Phone number" text
          const allElements = Array.from(document.querySelectorAll('*'));
          const phoneLabel = allElements.find(el => {
            const text = (el.textContent || '').toLowerCase();
            return /phone.*number|enter.*phone/i.test(text) && text.length < 100;
          });
          
          if (phoneLabel) {
            // Find input near this label
            const form = phoneLabel.closest('form, div, section');
            if (form) {
              const inputs = Array.from(form.querySelectorAll('input'));
              // Find the first visible text/tel input
              for (const input of inputs) {
                const type = input.type.toLowerCase();
                if ((type === 'tel' || type === 'text' || type === '') && 
                    input.offsetParent !== null) {
                  return input;
                }
              }
            }
          }
          return null;
        });
        
        if (contextPhone && contextPhone.asElement()) {
          phoneInput = contextPhone.asElement();
          console.log('✓ Found phone input by context');
        }
      }
      
      if (phoneInput) {
        if (number) {
          console.log('Found phone input field, typing phone number...');
          
          // Focus and clear the input
          await phoneInput.focus();
          await HumanEmulation.randomDelay(200, 500);
          await phoneInput.click({ clickCount: 3 });
          await page.keyboard.press('Backspace');
          await HumanEmulation.randomDelay(200, 500);
          
          // Format phone number - remove any + or country code if present, Google will add it
          // SMSPool usually returns format like: +1234567890 or 1234567890
          // Ensure number is a string before calling replace
          const numberStr = String(number || '');
          let formattedNumber = numberStr.replace(/[^\d]/g, ''); // Remove all non-digits
          
          // If number starts with country code (like 1 for US), we might need to keep it
          // But Google's input might handle it differently, so try both formats
          console.log(`Original number: ${number}, Formatted: ${formattedNumber}`);
          
          // Type the phone number
          await phoneInput.type(formattedNumber, { delay: 50 + Math.random() * 50 });
          console.log(`✓ Phone number typed: ${formattedNumber}`);
        } else {
          console.log('⚠ Phone number not available - please enter it manually');
          console.log(`Rental/Order ID: ${orderId}`);
          console.log('The phone input field is ready. Enter your phone number when ready.');
          await phoneInput.focus();
          // Wait for user to enter manually (give them time)
          await HumanEmulation.randomDelay(10000, 15000);
        }
        
        await HumanEmulation.randomDelay(1000, 2000);
        
        // Try to click Next button or press Enter
        const nextButton = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]'));
          const nextBtn = buttons.find(btn => {
            const text = (btn.textContent || btn.value || btn.innerText || '').toLowerCase();
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            return (/next|continue|verify|submit/i.test(text) || /next|continue|verify/i.test(ariaLabel)) &&
                   !/cancel|back|previous/i.test(text);
          });
          if (nextBtn) {
            nextBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
            nextBtn.click();
            return true;
          }
          return false;
        });
        
        if (nextButton) {
          console.log('✓ Clicked Next button after phone number');
        } else {
          console.log('Next button not found, pressing Enter...');
          await page.keyboard.press('Enter');
        }
        
        await HumanEmulation.randomDelay(3000, 5000);
        
        // Wait for navigation or code input to appear
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        } catch (navError) {
          console.log('Navigation after phone number input completed or timed out');
        }
        
        // Check if we're now on the code input page
        const isCodePage = await page.evaluate(() => {
          const bodyText = document.body.textContent.toLowerCase();
          const hasCodeInput = document.querySelector('input[type="text"][maxlength="6"], input[type="text"][maxlength="8"]');
          return /enter.*code|verification.*code|code.*sent/i.test(bodyText) || !!hasCodeInput;
        });
        
        if (isCodePage) {
          console.log('✓ Successfully navigated to code input page');
        } else {
          console.log('⚠ May not have navigated to code input page yet');
        }
      } else {
        console.log('✗ Phone input field not found - cannot enter phone number');
        console.log('Debugging: Searching for all inputs on page...');
        const allInputs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('input')).map(input => ({
            type: input.type,
            name: input.name,
            id: input.id,
            placeholder: input.placeholder,
            ariaLabel: input.getAttribute('aria-label'),
            visible: input.offsetParent !== null
          }));
        });
        console.log('All inputs found:', JSON.stringify(allInputs, null, 2));
        throw new Error('Phone input field not found');
      }

      // Wait for SMS code using phone number or order ID
      if (orderId || number) {
        const identifier = number ? String(number).replace(/[^\d]/g, '') : orderId;
        console.log(`Waiting for SMS code (checking for: ${identifier})...`);
        console.log('This may take 1-3 minutes. Please wait...');
        
        try {
          const smsCode = await this.smspool.waitForSMS(identifier);
          console.log(`✓ Received SMS code: ${smsCode}`);
          
          // Wait a bit for code input to appear
          await HumanEmulation.randomDelay(2000, 3000);
          
          // Find code input field
          const codeSelectors = [
            'input[type="text"][maxlength="6"]',
            'input[type="text"][maxlength="8"]',
            'input[name*="code"]',
            'input[id*="code"]',
            'input[aria-label*="code" i]',
            'input[placeholder*="code" i]'
          ];
          
          let codeInput = null;
          for (const selector of codeSelectors) {
            try {
              codeInput = await page.waitForSelector(selector, { timeout: 10000 });
              if (codeInput) {
                console.log(`✓ Found code input using selector: ${selector}`);
                break;
              }
            } catch (e) {
              continue;
            }
          }
          
          if (codeInput) {
            await codeInput.focus();
            await HumanEmulation.randomDelay(200, 500);
            await codeInput.type(smsCode, { delay: 50 + Math.random() * 50 });
            console.log(`✓ SMS code entered: ${smsCode}`);
            await HumanEmulation.randomDelay(500, 1000);
            await codeInput.press('Enter');
            console.log('✓ Submitted SMS code');
          } else {
            console.log('⚠ Code input field not found, trying to type anywhere');
            await page.keyboard.type(smsCode, { delay: 100 });
            await page.keyboard.press('Enter');
          }

          // Wait for navigation after submitting SMS code (page will redirect after verification)
          console.log('Waiting for navigation after SMS verification...');
          try {
            await Promise.race([
              page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
              new Promise(resolve => setTimeout(resolve, 5000)) // Max 5s wait
            ]);
            console.log('✓ Navigation completed after SMS verification');
          } catch (navError) {
            console.log('Navigation wait completed or timed out (this is normal)');
          }
          
          await HumanEmulation.randomDelay(2000, 3000);
        } catch (smsError) {
          console.log('⚠ Could not retrieve SMS code automatically:', smsError.message);
          console.log(`Phone Number: ${number || 'N/A'}`);
          console.log(`Rental/Order ID: ${orderId || 'N/A'}`);
          console.log('Please check your SMSPool dashboard for the SMS code and enter it manually.');
          console.log('The code input field should be ready for manual entry.');
        }
      } else {
        console.log('⚠ No phone number or order ID available - cannot retrieve SMS code automatically');
        console.log('Please enter the SMS code manually when it arrives.');
      }
    } catch (error) {
      console.error('SMS verification error:', error.message);
      // Don't throw - let the login process continue without SMS verification
      console.log('Continuing without SMS verification...');
    }
  }
}
