import { AdsPowerService } from '../services/adspower.js';
import { analyzePersonaFromEmails } from '../services/openai.js';
import { Profile } from '../models/Profile.js';
import { InteractionLog } from '../models/InteractionLog.js';
import { HumanEmulation } from '../utils/humanEmulation.js';
import { SMSPoolService } from '../services/smspool.js';
import { CaptchaService } from '../services/captchaService.js';
import { generate } from 'otplib';
import dotenv from 'dotenv';

dotenv.config();

export class DNAAnalysis {
  constructor() {
    this.adspower = new AdsPowerService();
    this.smspool = new SMSPoolService();
    this.captchaService = new CaptchaService();
  }

  async checkYouTubeAccountStatus(page, profileId) {
    try {
      if (!page || page.isClosed()) {
        console.log('Page not available for YouTube check');
        return 'Not checked';
      }

      console.log('Navigating to YouTube to check account status...');
      await page.goto('https://www.youtube.com', { waitUntil: 'networkidle2', timeout: 30000 });
      await HumanEmulation.randomDelay(3000, 5000);

      // Check if account is logged in and has YouTube channel
      const accountInfo = await page.evaluate(() => {
        const bodyText = document.body.textContent || document.body.innerText || '';
        const lowerText = bodyText.toLowerCase();
        
        // Check for banned channel indicators
        const isBanned = lowerText.includes('this channel has been terminated') ||
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
        
        // Check if user is logged in - look for multiple indicators
        const hasAccountMenu = document.querySelector('button[aria-label*="Account" i], button[id*="avatar"], img[alt*="Account" i], button[aria-label*="Google Account" i]');
        const hasChannelButton = document.querySelector('a[href*="/channel/"], a[href*="/c/"], a[href*="/user/"], a[href*="/@"]');
        const hasCreateButton = document.querySelector('button[aria-label*="Create" i], a[href*="/create"], button[title*="Create" i]');
        const hasStudioButton = document.querySelector('a[href*="/studio"], a[href*="/dashboard"]');
        const hasProfilePicture = document.querySelector('img[alt*="Avatar" i], img[alt*="Profile" i], button[id*="avatar"] img');
        
        // Check for explicit "Sign in" button in prominent location (not just any sign in link)
        const signInElements = Array.from(document.querySelectorAll('a[href*="/ServiceLogin"], button, a[href*="accounts.google.com"]')).filter(el => {
          const text = (el.textContent || '').toLowerCase().trim();
          const href = (el.getAttribute('href') || '').toLowerCase();
          const className = (el.className || '').toLowerCase();
          // Check if it's a prominent sign-in button (not just any link)
          return (text.includes('sign in') || text === 'sign in') && 
                 (href.includes('servicelogin') || className.includes('sign') || el.tagName === 'BUTTON');
        });
        const hasProminentSignIn = signInElements.length > 0;
        
        // More lenient: if we have ANY logged-in indicators, consider logged in
        const isLoggedIn = !!hasAccountMenu || !!hasChannelButton || !!hasCreateButton || !!hasStudioButton || !!hasProfilePicture;
        
        return {
          isBanned,
          isLoggedIn,
          hasAccountMenu: !!hasAccountMenu,
          hasChannelButton: !!hasChannelButton,
          hasCreateButton: !!hasCreateButton,
          hasStudioButton: !!hasStudioButton,
          hasProfilePicture: !!hasProfilePicture,
          hasProminentSignIn
        };
      });

      console.log('YouTube account check details:', JSON.stringify(accountInfo, null, 2));

      // Check if banned FIRST (before any other checks)
      if (accountInfo.isBanned) {
        console.log('✗ YouTube account is BANNED');
        return 'Banned Youtube';
      }

      // Since we're logged into Google (we're doing DNA analysis), YouTube account should exist
      // Only return "No YouTube Account" if we have STRONG evidence (prominent sign-in AND no logged-in indicators)
      const hasStrongEvidenceOfNoAccount = accountInfo.hasProminentSignIn && !accountInfo.isLoggedIn;
      
      if (hasStrongEvidenceOfNoAccount) {
        console.log('⚠ Strong evidence of no YouTube account (prominent sign-in button and no logged-in indicators)');
        return 'No YouTube Account';
      }

      // If we have ANY logged-in indicators, definitely account exists
      if (accountInfo.isLoggedIn) {
        console.log('✓ YouTube account exists (logged in indicators found)');
        return 'YouTube Account Created';
      }

      // Default: Since we're logged into Google, assume YouTube account exists
      // (All Google accounts have YouTube access, even if they haven't created a channel)
      console.log('✓ YouTube account exists (default: logged into Google account)');
      return 'YouTube Account Created';
    } catch (error) {
      console.error('Error checking YouTube account status:', error.message);
      return 'Check failed';
    }
  }

  async getLocationFromProxyIP(ipAddress) {
    try {
      if (!ipAddress || typeof ipAddress !== 'string') {
        return null;
      }

      // Validate IP address format (basic check)
      const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (!ipPattern.test(ipAddress)) {
        console.log(`Invalid IP address format: ${ipAddress}`);
        return null;
      }

      // Use free IP geolocation API (ip-api.com - no API key required for basic usage)
      const response = await fetch(`http://ip-api.com/json/${ipAddress}?fields=status,country,regionName,city,lat,lon`);
      const data = await response.json();

      if (data.status === 'success' && data.country) {
        // Format: "City, Region, Country" or "Country" if city/region not available
        const locationParts = [];
        if (data.city) locationParts.push(data.city);
        if (data.regionName) locationParts.push(data.regionName);
        if (data.country) locationParts.push(data.country);
        
        const location = locationParts.length > 0 ? locationParts.join(', ') : data.country;
        console.log(`✓ IP geolocation result for ${ipAddress}: ${location}`);
        return location;
      } else {
        console.log(`⚠ IP geolocation failed for ${ipAddress}: ${data.message || 'Unknown error'}`);
        return null;
      }
    } catch (error) {
      console.error(`Error getting location from IP ${ipAddress}:`, error.message);
      return null;
    }
  }

  ensureDialogHandler(page) {
    if (!page || page.isClosed()) return;
    if (page.__dnaDialogHandlerAttached) return;
    page.__dnaDialogHandlerAttached = true;

    const handled = new WeakSet();
    page.on('dialog', async (dialog) => {
      try {
        if (handled.has(dialog)) return;
        handled.add(dialog);

        if (dialog.type() === 'beforeunload') {
          await dialog.accept().catch((e) => {
            if (!String(e?.message || '').includes('already handled')) throw e;
          });
        } else {
          await dialog.dismiss().catch((e) => {
            if (!String(e?.message || '').includes('already handled')) throw e;
          });
        }
      } catch (e) {
        const msg = String(e?.message || e || '');
        if (!msg.includes('already handled')) {
          console.warn('Dialog handler error:', msg);
        }
      }
    });
  }

  async simulateHumanLoggedInGmail(page) {
    if (!page || page.isClosed()) return;
    try {
      await HumanEmulation.randomDelay(1500, 2500);
      await HumanEmulation.simulateReading(page, 1500 + Math.random() * 1500);
      await page.evaluate(() => {
        window.scrollBy(0, 120 + Math.floor(Math.random() * 180));
      }).catch(() => {});
      await HumanEmulation.randomDelay(800, 1400);

      const clickedMenu = await page.evaluate(() => {
        const selectors = [
          'a[aria-label*="Google Account" i]',
          'button[aria-label*="Google Account" i]',
          'a[aria-label*="Account" i]',
          'button[aria-label*="Account" i]',
          '[data-tooltip*="Google Account" i]',
          '[data-tooltip*="Account" i]'
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              el.click();
              return true;
            }
          }
        }
        return false;
      }).catch(() => false);

      if (clickedMenu) {
        await HumanEmulation.randomDelay(1200, 2200);
        await page.keyboard.press('Escape').catch(() => {});
        await HumanEmulation.randomDelay(600, 1200);
      }

      await page.evaluate(() => {
        window.scrollBy(0, -80 - Math.floor(Math.random() * 120));
      }).catch(() => {});
      await HumanEmulation.randomDelay(800, 1400);
    } catch (e) {
      console.log('simulateHumanLoggedInGmail skipped:', e.message);
    }
  }

  async analyzeProfile(profileId, options = {}) {
    const profile = await Profile.findById(profileId);
    if (!profile) {
      throw new Error(`Profile ${profileId} not found`);
    }
    
    // Debug: Log profile data to verify TOTP secret is loaded
    console.log(`Profile loaded - Email: ${profile.email}, Has TOTP Secret: ${!!profile.totpSecret}, TOTP Secret length: ${profile.totpSecret?.length || 0}`);

    let browser;
    let page;

    try {
      // Navigate directly to Gmail instead of showing start.adspower.net
      const openTabs = options.runHidden === false ? 1 : 0;
      browser = await this.adspower.connectBrowser(profileId, { initialUrl: 'https://gmail.com', openTabs });
      
      // Ensure start.adspower.net page is closed (extra safety check)
      try {
        const pages = await browser.pages();
        for (const p of pages) {
          try {
            const url = p.url();
            if (url.includes('start.adspower.net')) {
              console.log('Closing start.adspower.net page (DNA analysis safety check)...');
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

      this.ensureDialogHandler(page);

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
          this.ensureDialogHandler(page);
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
      console.log(`✓ Scraped ${emailData?.length || 0} email(s) from Gmail (Primary, Promotions, Social)`);
      
      // Check if we have enough meaningful email data (at least 3 emails with content)
      const hasEnoughData = emailData && emailData.length >= 3 && 
                           emailData.some(email => (email.subject || email.snippet || email.rawText) && 
                                          (email.subject?.length > 10 || email.snippet?.length > 20 || email.rawText?.length > 20));
      
      // Always try to scrape account settings to get name, birthday/age, gender, location, language, etc.
      console.log('=== Attempting to scrape account settings for name, birthday/age, gender, location, language ===');
      let settingsData = null;
      try {
        settingsData = await this.scrapeGmailAccountSettings(page, profile);
        if (settingsData && settingsData.length > 0) {
          const settings = settingsData[0];
          const extractedFields = [];
          if (settings.name) extractedFields.push('name');
          if (settings.birthday) extractedFields.push('birthday');
          if (settings.gender) extractedFields.push('gender');
          if (settings.location) extractedFields.push('location');
          if (settings.language) extractedFields.push('language');
          if (settings.email) extractedFields.push('email');
          if (settings.recoveryEmail) extractedFields.push('recoveryEmail');
          if (settings.phoneNumber) extractedFields.push('phoneNumber');
          
          console.log(`✓ Account settings data retrieved with: ${extractedFields.join(', ') || 'no fields'}`);
          if (extractedFields.length > 0) {
            console.log(`  - Extracted fields: ${extractedFields.join(', ')}`);
          }
        } else {
          console.log('⚠ Account settings scraping returned no data');
        }
      } catch (settingsError) {
        console.log('⚠ Account settings scraping failed:', settingsError.message);
      }

      if (!hasEnoughData) {
        console.log(`⚠ Insufficient email data (${emailData?.length || 0} emails) - using account settings or fallback`);
        
        if (settingsData && settingsData.length > 0) {
          console.log('✓ Using account settings data as primary source');
          emailData = settingsData;
        } else {
          console.log('⚠ Account settings unavailable, trying basic fallback data');
          emailData = await this.getFallbackData(page);
          console.log(`Fallback data retrieved: ${emailData?.length || 0} item(s)`);
        }
        
        if (!emailData || emailData.length === 0) {
          console.error('✗ No email data or account settings available - cannot perform analysis');
          throw new Error('No email data or account settings could be scraped from Gmail');
        }
      } else {
        console.log('✓ Sufficient email data found for analysis');
        // Always merge account settings data (name, birthday, gender, location, language, etc.) with email data if available
        if (settingsData && settingsData.length > 0) {
          const settings = settingsData[0];
          const hasAnyData = settings.name || settings.birthday || settings.gender || 
                           settings.location || settings.language || settings.email;
          
          if (hasAnyData) {
            console.log('✓ Merging account settings (name, birthday, gender, location, language, etc.) with email data for more accurate analysis');
            // Add account settings as additional context to email data
            emailData.push({
              ...settings,
              note: 'Account settings data - includes name, birthday, gender, location, language, and other personal information'
            });
          }
        }
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
        
        // Merge account settings data (name, birthday, language) into persona if available
        // Location will come from proxy instead of personal info
        if (settingsData && settingsData.length > 0) {
          const settings = settingsData[0];
          if (settings.name) persona.name = settings.name;
          if (settings.birthday) persona.birthday = settings.birthday;
          if (settings.language) persona.language = settings.language;
          console.log('✓ Merged account settings data into persona:', {
            name: settings.name || 'not found',
            birthday: settings.birthday || 'not found',
            language: settings.language || 'not found'
          });
        }
        
        // Get location from proxy IP address using geolocation
        if (profile.proxy && profile.proxy.host) {
          try {
            const proxyLocation = await this.getLocationFromProxyIP(profile.proxy.host);
            if (proxyLocation) {
              persona.location = proxyLocation;
              console.log(`✓ Got location from proxy IP ${profile.proxy.host}: ${proxyLocation}`);
            } else {
              console.log(`⚠ Could not determine location from proxy IP ${profile.proxy.host}`);
            }
          } catch (geoError) {
            console.log(`⚠ Error getting location from proxy IP: ${geoError.message}`);
          }
        }
        
        console.log('=== Updating profile persona in database ===');
      await Profile.updatePersona(profileId, persona);
        console.log('✓ Profile persona updated in database');
      } catch (openaiError) {
        console.error('✗ OpenAI analysis failed:', openaiError.message);
        throw openaiError;
      }

      // Always check YouTube during DNA (even if persona/OpenAI failed) so script does not skip it
      console.log('=== Checking YouTube account status ===');
      let youtubeStatus = 'Not checked';
      try {
        // Ensure we have a valid page for YouTube check
        let youtubePage = page;
        if (!youtubePage || youtubePage.isClosed()) {
          console.log('Page is closed, getting a new page for YouTube check...');
          const pages = await browser.pages();
          youtubePage = pages.find(p => !p.isClosed()) || pages[0];
          if (!youtubePage || youtubePage.isClosed()) {
            youtubePage = await browser.newPage();
            console.log('✓ Created new page for YouTube check');
          }
        }
        
        if (youtubePage && !youtubePage.isClosed()) {
          youtubeStatus = await this.checkYouTubeAccountStatus(youtubePage, profileId);
          console.log(`✓ YouTube account status: ${youtubeStatus}`);
        } else {
          console.warn('⚠ Could not get valid page for YouTube check');
          youtubeStatus = 'Check failed';
        }
      } catch (youtubeError) {
        console.warn('⚠ Could not check YouTube account status:', youtubeError.message);
        youtubeStatus = 'Check failed';
      }

      const interests = (persona && persona.interests && Array.isArray(persona.interests))
        ? persona.interests.slice(0, 3).join(', ')
        : 'No interests';
      const notesPrefix = (persona && persona.gender && persona.ageBracket)
        ? `${persona.gender} | ${persona.ageBracket} | ${interests}`
        : null;
      let notesText = notesPrefix || '';
      if (youtubeStatus && youtubeStatus !== 'Not checked' && youtubeStatus !== 'Check failed') {
        notesText = notesText ? `${notesText} | ${youtubeStatus}` : youtubeStatus;
      }
      if (notesText) {
        console.log(`=== Updating AdsPower profile notes: "${notesText}" ===`);
        try {
          const notesResult = await this.adspower.updateProfileNotes(profileId, notesText);
          console.log('✓ AdsPower profile notes updated successfully');
        } catch (notesError) {
          console.error('✗ Failed to update AdsPower profile notes:', notesError.message);
        }
      }
      try {
        const latestProfile = await Profile.findById(profileId);
        const currentNotes = latestProfile?.notes || '';
        let updatedNotes = currentNotes
          .split('|')
          .map(part => part.trim())
          .filter(part => {
            const lowerPart = part.toLowerCase();
            return !lowerPart.includes('youtube account created') &&
                   !lowerPart.includes('no youtube account') &&
                   !lowerPart.includes('banned youtube') &&
                   part.length > 0;
          })
          .join(' | ')
          .trim();
        if (youtubeStatus && youtubeStatus !== 'Not checked' && youtubeStatus !== 'Check failed') {
          if (!updatedNotes.toLowerCase().includes(youtubeStatus.toLowerCase())) {
            updatedNotes = updatedNotes ? `${updatedNotes} | ${youtubeStatus}` : youtubeStatus;
          }
        }
        if (updatedNotes !== currentNotes && updatedNotes.trim() !== currentNotes.trim()) {
          await Profile.update(profileId, { notes: updatedNotes });
          console.log(`✓ Updated local profile notes with YouTube status: ${updatedNotes}`);
        }
      } catch (localNotesError) {
        console.warn('⚠ Could not update local profile notes:', localNotesError.message);
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
      
      // Check for wrong credentials error
      const isWrongCredentials = error.name === 'WrongCredentialsError' || 
                                 error.message.includes('Wrong Credentials') ||
                                 error.message.includes('Wrong password') ||
                                 error.message.includes('incorrect password') ||
                                 error.message.includes('Invalid Account') ||
                                 error.message.includes('invalid account');
      
      if (isWrongCredentials) {
        console.error('✗✗✗ INVALID ACCOUNT / WRONG CREDENTIALS DETECTED IN DNA ANALYSIS ✗✗✗');
        const invalidStatus = 'Invalid Account';
        try {
          await Profile.update(profileId, { 
            notes: invalidStatus,
            status: 'error'
          });
          await this.adspower.updateProfileNotes(profileId, invalidStatus);
          console.log(`✓ Profile notes updated with "${invalidStatus}" status`);
        } catch (updateError) {
          console.warn('Could not update profile notes:', updateError.message);
        }
        
        try {
          const log = new InteractionLog({
            profileId,
            action: 'dna_analysis',
            url: 'https://gmail.com',
            success: false,
            error: 'Invalid Account - Password is incorrect or account has been taken back'
          });
          await log.save();
        } catch (logError) {
          console.error('Failed to save error log:', logError);
        }
        
        // Don't throw - return empty persona instead of crashing
        return {
          gender: 'unknown',
          ageBracket: 'unknown',
          interests: []
        };
      }
      
      const isProxyError = error.message && (error.message.includes('ERR_PROXY_CONNECTION_FAILED') || error.message.toLowerCase().includes('proxy'));
      if (isProxyError) {
        try {
          await Profile.flagNetworkError(profileId, true);
          console.warn(`✓ Profile ${profileId} marked with proxy/network error (check proxy settings)`);
        } catch (flagErr) {
          console.warn('Could not flag profile network error:', flagErr.message);
        }
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

      if (isProxyError) {
        throw new Error('Proxy connection failed. Profile marked with network error — check proxy settings for this profile.');
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

  async scrapeGmail(page, profile) {
    try {
      // Check if page is still valid
      if (page.isClosed()) {
        console.log('Page closed, cannot scrape Gmail');
        return await this.getFallbackData(page);
      }

      this.ensureDialogHandler(page);

      // Navigate to Gmail inbox directly
      try {
        await page.goto('https://mail.google.com/mail/u/0/#inbox?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
        await HumanEmulation.randomDelay(3000, 5000);
        
        // Check for Gmail app upgrade page and click "Use the web version" if present
        await this.handleGmailAppUpgradePage(page, profile);
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
      
      if (isLoggedIn) {
        await this.simulateHumanLoggedInGmail(page);
      }
      
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
                
                // Check if it's a wrong credentials error
                if (loginError.name === 'WrongCredentialsError' || loginError.message.includes('Wrong Credentials')) {
                  console.error('✗✗✗ INVALID ACCOUNT / WRONG CREDENTIALS DETECTED ✗✗✗');
                  console.error('Account password is incorrect or account has been taken back');
                  
                  const invalidStatus = 'Invalid Account';
                  const profileIdToUpdate = profile.adspowerId || profile._id || profile.id;
                  
                  if (!profileIdToUpdate) {
                    console.error('✗ Cannot update profile - profileId not found in profile object');
                    console.error('Profile object keys:', Object.keys(profile));
                  } else {
                    // Update profile notes with Invalid Account status
                    try {
                      await Profile.update(profileIdToUpdate, { 
                        notes: invalidStatus,
                        status: 'error'
                      });
                      await this.adspower.updateProfileNotes(profileIdToUpdate, invalidStatus);
                      console.log(`✓ Profile notes updated with "${invalidStatus}" status for profile ${profileIdToUpdate}`);
                    } catch (updateError) {
                      console.warn('Could not update profile notes:', updateError.message);
                    }
                    
                    // Log the error
                    try {
                      const log = new InteractionLog({
                        profileId: profileIdToUpdate,
                        action: 'dna_analysis',
                        url: 'https://gmail.com',
                        success: false,
                        error: 'Invalid Account - Password is incorrect or account has been taken back'
                      });
                      await log.save();
                    } catch (logError) {
                      console.warn('Could not save error log:', logError.message);
                    }
                  }
                  
                  // Re-throw as WrongCredentialsError so it can be caught by analyzeProfile
                  throw loginError;
                }
                
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
            await page.goto('https://mail.google.com/mail/u/0/#inbox?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
          await HumanEmulation.randomDelay(3000, 5000);
            
            // Check for Gmail app upgrade page and click "Use the web version" if present
            await this.handleGmailAppUpgradePage(page, profile);
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

      // Scrape emails from Primary tab (inbox)
      console.log('=== Scraping Primary tab (Inbox) ===');
      const primaryEmails = await this.scrapeEmailsFromTab(page, emailSelector, 'Primary');
      console.log(`✓ Scraped ${primaryEmails.length} email(s) from Primary tab`);
      
      // Scrape emails from Promotions tab
      let promotionsEmails = [];
      try {
        console.log('=== Scraping Promotions tab ===');
        console.log('Navigating to Promotions tab...');
        await page.goto('https://mail.google.com/mail/u/0/#category/promotions?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
        await HumanEmulation.randomDelay(3000, 5000);
        promotionsEmails = await this.scrapeEmailsFromTab(page, emailSelector, 'Promotions');
        console.log(`✓ Scraped ${promotionsEmails.length} email(s) from Promotions tab`);
      } catch (promoError) {
        console.warn('⚠ Could not scrape Promotions tab:', promoError.message);
        console.warn('Promotions tab error details:', promoError);
      }
      
      // Scrape emails from Social tab
      let socialEmails = [];
      try {
        console.log('=== Scraping Social tab ===');
        console.log('Navigating to Social tab...');
        await page.goto('https://mail.google.com/mail/u/0/#category/social?hl=en', { waitUntil: 'networkidle2', timeout: 30000 });
        await HumanEmulation.randomDelay(3000, 5000);
        socialEmails = await this.scrapeEmailsFromTab(page, emailSelector, 'Social');
        console.log(`✓ Scraped ${socialEmails.length} email(s) from Social tab`);
      } catch (socialError) {
        console.warn('⚠ Could not scrape Social tab:', socialError.message);
        console.warn('Social tab error details:', socialError);
      }

      // Combine all emails, removing duplicates based on subject and sender
      const allEmails = [...primaryEmails, ...promotionsEmails, ...socialEmails];
      const uniqueEmails = [];
      const seenEmails = new Set();
      
      for (const email of allEmails) {
        const emailKey = `${email.subject || ''}_${email.sender || ''}`.toLowerCase();
        if (!seenEmails.has(emailKey) && (email.subject || email.snippet || email.sender)) {
          seenEmails.add(emailKey);
          uniqueEmails.push(email);
        }
      }

      console.log(`✓ Total unique emails scraped: ${uniqueEmails.length} (Primary: ${primaryEmails.length}, Promotions: ${promotionsEmails.length}, Social: ${socialEmails.length})`);

      if (uniqueEmails.length === 0) {
        const fallbackData = await this.getFallbackData(page);
        return fallbackData;
      }

      return uniqueEmails;
    } catch (error) {
      console.error('Gmail scraping error:', error);
      
      // If it's a wrong credentials error, re-throw it so analyzeProfile can handle it properly
      if (error.name === 'WrongCredentialsError' || error.message.includes('Wrong Credentials')) {
        throw error; // Re-throw to stop the process and mark account as invalid
      }
      
      // For other errors, return fallback data
      return await this.getFallbackData(page);
    }
  }

  async scrapeEmailsFromTab(page, emailSelector, tabName) {
    try {
      if (page.isClosed()) {
        return [];
      }

      // Wait a bit for emails to load
      await HumanEmulation.randomDelay(2000, 3000);

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

      return emails || [];
    } catch (error) {
      console.warn(`Error scraping ${tabName} tab:`, error.message);
      return [];
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

      this.ensureDialogHandler(page);

      // Navigate to Google Account settings page - force English language
      try {
        // Force English language by adding ?hl=en parameter
        await page.goto('https://myaccount.google.com/personal-info?hl=en', { 
          waitUntil: 'networkidle2', 
          timeout: 30000 
        });
        await HumanEmulation.randomDelay(3000, 5000);
        
        // Verify page is in English, if not, try to change language
        const pageLanguage = await page.evaluate(() => {
          const htmlLang = document.documentElement.getAttribute('lang');
          const bodyText = document.body.textContent || '';
          // Check if page contains English indicators
          const hasEnglish = /personal info|name|email|gender|birthday|language/i.test(bodyText);
          return { htmlLang, hasEnglish };
        });
        
        if (!pageLanguage.hasEnglish && pageLanguage.htmlLang && !pageLanguage.htmlLang.startsWith('en')) {
          console.log(`Page language detected as ${pageLanguage.htmlLang}, forcing English...`);
          // Try to click language selector or navigate with English parameter
          try {
            await page.goto('https://myaccount.google.com/personal-info?hl=en', { 
              waitUntil: 'networkidle2', 
              timeout: 30000 
            });
            await HumanEmulation.randomDelay(2000, 3000);
          } catch (langError) {
            console.log('Could not force English, continuing with current language:', langError.message);
          }
        }
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
          await page.goto('https://myaccount.google.com/?hl=en', { 
            waitUntil: 'networkidle2', 
            timeout: 30000 
          });
          await HumanEmulation.randomDelay(2000, 4000);
        } catch (altNavError) {
          console.log('Alternative settings navigation failed:', altNavError.message);
        }
      }

      // Check for home address page and skip it if present
      await this.handleHomeAddressPage(page, profile);
      
      // Try to navigate to birthday section specifically
      try {
        const birthdayLink = await page.evaluateHandle(() => {
          const links = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"]'));
          return links.find(el => {
            const text = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
            return text.includes('birthday') || text.includes('date of birth') || text.includes('birth date');
          });
        });
        
        if (birthdayLink && birthdayLink.asElement()) {
          console.log('Found birthday link, clicking to navigate to birthday section...');
          await HumanEmulation.randomDelay(1000, 2000);
          await birthdayLink.asElement().click();
          await HumanEmulation.randomDelay(3000, 5000);
          
          // Check for home address page again after navigation
          await this.handleHomeAddressPage(page, profile);
        }
      } catch (birthdayNavError) {
        console.log('Could not navigate to birthday section, continuing with general settings:', birthdayNavError.message);
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

        // Helper function to find value after a label - improved precision
        const findValueAfterLabel = (labelText) => {
          // Find elements that contain ONLY the label text (exact match or with colon/space)
          const labelPattern = new RegExp(`^${labelText}[\\s:]*$`, 'i');
          const allElements = Array.from(document.querySelectorAll('div, span, p, label, h1, h2, h3, h4, h5, h6'));
          
          for (const el of allElements) {
            const text = (el.textContent || '').trim();
            // Check if element text matches label exactly or starts with label followed by colon/space
            if (labelPattern.test(text) || text.toLowerCase() === labelText.toLowerCase()) {
              // Look for value in next sibling
              let next = el.nextElementSibling;
              let attempts = 0;
              while (next && attempts < 5) {
                const nextText = (next.textContent || '').trim();
                if (nextText && nextText.length > 0 && 
                    !nextText.toLowerCase().includes(labelText.toLowerCase()) &&
                    nextText !== 'Edit' && nextText !== 'Change' && nextText !== 'Update') {
                  return nextText;
                }
                next = next.nextElementSibling;
                attempts++;
              }
              
              // Look in parent's children (siblings of label element)
              if (el.parentElement) {
                const siblings = Array.from(el.parentElement.children);
                const labelIndex = siblings.indexOf(el);
                if (labelIndex >= 0 && labelIndex < siblings.length - 1) {
                  for (let i = labelIndex + 1; i < siblings.length && i < labelIndex + 3; i++) {
                    const siblingText = (siblings[i].textContent || '').trim();
                    if (siblingText && siblingText.length > 0 &&
                        !siblingText.toLowerCase().includes(labelText.toLowerCase()) &&
                        siblingText !== 'Edit' && siblingText !== 'Change' && siblingText !== 'Update') {
                      return siblingText;
                    }
                  }
                }
              }
              
              // Extract from parent container text - split by label
              if (el.parentElement) {
                const parentText = el.parentElement.textContent || '';
                const regex = new RegExp(`${labelText}[\\s:]+([^\\n]+)`, 'i');
                const match = parentText.match(regex);
                if (match && match[1]) {
                  const value = match[1].trim().split(/\n/)[0].trim();
                  if (value && value.length > 0 && 
                      !value.toLowerCase().includes(labelText.toLowerCase()) &&
                      value !== 'Edit' && value !== 'Change' && value !== 'Update') {
                    return value;
                  }
                }
              }
            }
          }
          return null;
        };

        // Extract Name - structured approach
        const nameValue = findValueAfterLabel('Name');
        if (nameValue) {
          // Clean up - remove "Edit" or other UI text, get first line only
          const cleaned = nameValue.split(/\n/)[0].trim()
            .replace(/Edit|Change|Update|Add/gi, '').trim();
          // Validate it looks like a name (2-4 words, capitalized, no special chars except spaces and hyphens)
          if (cleaned && cleaned.length > 2 && cleaned.length < 50 && 
              /^[A-Z][a-zA-Z\s-]+$/.test(cleaned) && 
              cleaned.split(/\s+/).length >= 1 && cleaned.split(/\s+/).length <= 4) {
            data.name = cleaned;
          }
        }
        
        // Fallback: try direct text pattern
        if (!data.name) {
          const namePattern = /name[:\s\n]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i;
          const match = document.body.textContent.match(namePattern);
          if (match && match[1]) {
            data.name = match[1].trim();
          }
        }

        // Extract Email - structured approach
        const emailValue = findValueAfterLabel('Email');
        if (emailValue) {
          // Extract email from the value - must be a valid email format
          const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
          const emailMatch = emailValue.match(emailPattern);
          if (emailMatch && emailMatch[0].indexOf('@') > 0 && emailMatch[0].indexOf('.') > emailMatch[0].indexOf('@')) {
            data.email = emailMatch[0];
          }
        }
        
        // Fallback: look for email patterns in text - prioritize emails that look like primary emails
        if (!data.email) {
          const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
          const emailMatches = document.body.textContent.match(emailPattern);
          if (emailMatches && emailMatches.length > 0) {
            // Filter out emails that look like recovery emails or temporary emails
            const primaryEmails = emailMatches.filter(email => 
              !email.includes('gmail.com') || 
              (email.includes('@gmail.com') && !email.includes('anhnhat.online'))
            );
            if (primaryEmails.length > 0) {
              data.email = primaryEmails[0];
            } else {
              data.email = emailMatches[0];
            }
            if (emailMatches.length > 1) {
              data.recoveryEmail = emailMatches[1];
            }
          }
        }

        // Also try form inputs
        if (!data.email) {
          const emailInputs = Array.from(document.querySelectorAll('input[type="email"], [data-email], a[href^="mailto:"]'));
          for (const element of emailInputs) {
            const email = element.value || 
                         element.getAttribute('data-email') || 
                         element.textContent?.trim() ||
                         element.getAttribute('href')?.replace('mailto:', '') || '';
            if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              data.email = email;
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

        // Extract Birthday - structured approach
        const birthdayValue = findValueAfterLabel('Birthday');
        if (birthdayValue) {
          // Extract date pattern
          const datePattern = /([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})|(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})|(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/;
          const dateMatch = birthdayValue.match(datePattern);
          if (dateMatch && !birthdayValue.toLowerCase().includes('not set')) {
            data.birthday = dateMatch[0].trim();
          }
        }
        
        // Fallback: try text patterns
        if (!data.birthday) {
          const birthdayPatterns = [
            /birthday[:\s]+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
            /birthday[:\s]+([A-Z][a-z]{2,3}\s+\d{1,2},?\s+\d{4})/i,
            /date\s+of\s+birth[:\s]+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i
          ];
          
          for (const pattern of birthdayPatterns) {
            const match = document.body.textContent.match(pattern);
            if (match && match[1]) {
              data.birthday = match[1].trim();
              break;
            }
          }
        }

        // Also try to find birthday from structured elements near "Birthday" label
        if (!data.birthday) {
          const birthdayLabels = Array.from(document.querySelectorAll('div, span, p, label, h1, h2, h3')).filter(el => {
            const text = (el.textContent || '').toLowerCase();
            return text.includes('birthday') || text.includes('date of birth') || text.includes('birth date');
          });
          
          for (const label of birthdayLabels) {
            // Check next sibling
            const nextSibling = label.nextElementSibling;
            if (nextSibling) {
              const siblingText = (nextSibling.textContent || nextSibling.value || '').trim();
              // Match formats like "December 4, 1978" or "Dec 4, 1978" or "12/4/1978"
              const dateMatch = siblingText.match(/([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})|(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})|(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/);
              if (dateMatch) {
                data.birthday = dateMatch[0];
                break;
              }
            }
            
            // Check parent container
            const parent = label.parentElement;
            if (parent) {
              const parentText = parent.textContent || '';
              const dateMatch = parentText.match(/([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})|(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})|(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/);
              if (dateMatch) {
                data.birthday = dateMatch[0];
                break;
              }
            }
            
            if (data.birthday) break;
          }
        }

        // Also try form inputs
        if (!data.birthday) {
          const birthdaySelectors = [
            'input[type="date"]',
            'input[name*="birth"]',
            'input[name*="date"]',
            'input[aria-label*="birth" i]',
            '[data-birthday]',
            '[data-date-of-birth]'
          ];
          for (const selector of birthdaySelectors) {
            const elements = Array.from(document.querySelectorAll(selector));
            for (const element of elements) {
              const value = element.value || 
                           element.getAttribute('data-birthday') || 
                           element.getAttribute('data-date-of-birth') ||
                           element.textContent?.trim() || '';
              if (value && value.length > 0) {
                data.birthday = value;
                break;
              }
            }
            if (data.birthday) break;
          }
        }

        // Extract Gender - structured approach
        const genderValue = findValueAfterLabel('Gender');
        if (genderValue) {
          const normalized = genderValue.toLowerCase().trim();
          // Make sure it's not combining with other text
          if (normalized === 'male' || (normalized.includes('male') && !normalized.includes('female') && normalized.length < 10)) {
            data.gender = 'Male';
          } else if (normalized === 'female' || (normalized.includes('female') && normalized.length < 10)) {
            data.gender = 'Female';
          } else if (normalized === 'other' || normalized.includes('prefer not') || normalized.includes('prefer not to say')) {
            data.gender = 'Other';
          } else if (normalized.length > 0 && normalized.length < 20 && !normalized.includes('gender')) {
            // Only use if it's a single word value
            const words = normalized.split(/\s+/);
            if (words.length === 1) {
              data.gender = genderValue.trim().charAt(0).toUpperCase() + genderValue.trim().slice(1).toLowerCase();
            }
          }
        }
        
        // Fallback: try form elements
        if (!data.gender) {
          const genderSelectors = [
            'select[name*="gender"]',
            'input[name*="gender"]',
            '[data-gender]',
            'div[data-gender]',
            'span[data-gender]',
            '[aria-label*="gender" i]',
            '[aria-label*="sex" i]'
          ];
          for (const selector of genderSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              const genderVal = element.value || 
                               element.getAttribute('data-gender') || 
                               element.getAttribute('aria-label') ||
                               element.textContent?.trim() || '';
              if (genderVal) {
                // Normalize gender value
                const normalized = genderVal.toLowerCase();
                if (normalized.includes('male') && !normalized.includes('female')) {
                  data.gender = 'Male';
                } else if (normalized.includes('female')) {
                  data.gender = 'Female';
                } else if (normalized.includes('other') || normalized.includes('prefer not')) {
                  data.gender = 'Other';
                } else {
                  data.gender = genderVal;
                }
                if (data.gender) break;
              }
            }
          }
        }
        
        // If gender not found in form elements, search in page text
        if (!data.gender) {
          const genderTextPatterns = [
            /gender[:\s]+(male|female|other)/i,
            /sex[:\s]+(male|female|other)/i,
            /\b(male|female)\b/i
          ];
          
          for (const pattern of genderTextPatterns) {
            const match = document.body.textContent.match(pattern);
            if (match) {
              const found = match[1] || match[0];
              const normalized = found.toLowerCase();
              if (normalized.includes('male') && !normalized.includes('female')) {
                data.gender = 'Male';
              } else if (normalized.includes('female')) {
                data.gender = 'Female';
              } else {
                data.gender = found.charAt(0).toUpperCase() + found.slice(1).toLowerCase();
              }
              if (data.gender) break;
            }
          }
        }
        
        // Also check for gender in visible text near labels
        if (!data.gender) {
          const genderLabels = Array.from(document.querySelectorAll('label, span, div')).filter(el => {
            const text = (el.textContent || '').toLowerCase();
            return text.includes('gender') || text.includes('sex');
          });
          
          for (const label of genderLabels) {
            const nextSibling = label.nextElementSibling;
            const parent = label.parentElement;
            const siblings = parent ? Array.from(parent.children) : [];
            
            // Check next sibling
            if (nextSibling) {
              const siblingText = (nextSibling.textContent || '').toLowerCase().trim();
              if (siblingText.includes('male') && !siblingText.includes('female')) {
                data.gender = 'Male';
                break;
              } else if (siblingText.includes('female')) {
                data.gender = 'Female';
                break;
              }
            }
            
            // Check all siblings
            for (const sibling of siblings) {
              if (sibling !== label) {
                const siblingText = (sibling.textContent || '').toLowerCase().trim();
                if (siblingText === 'male' || siblingText === 'female' || siblingText === 'other') {
                  data.gender = siblingText.charAt(0).toUpperCase() + siblingText.slice(1);
                  break;
                }
              }
            }
            
            if (data.gender) break;
          }
        }

        // Location is not extracted from personal info - will use proxy location instead

        // Extract Language - structured approach
        const languageValue = findValueAfterLabel('Language');
        if (languageValue && !languageValue.toLowerCase().includes('not set') && !languageValue.toLowerCase().includes('add')) {
          // Clean up - get first meaningful line
          const cleaned = languageValue.split(/\n/)[0].trim();
          if (cleaned && cleaned.length > 2) {
            data.language = cleaned;
          }
        }
        
        // Fallback: try text patterns
        if (!data.language) {
          const languagePatterns = [
            /language[:\s]+([A-Z][a-z]+(?:\s+\([^)]+\))?)/i,
            /language[:\s]+([A-Z][a-zA-Z\s()]+?)(?:\n|$|Home|Work|Address)/i
          ];
          
          for (const pattern of languagePatterns) {
            const match = document.body.textContent.match(pattern);
            if (match && match[1]) {
              data.language = match[1].trim();
              break;
            }
          }
        }

        // Also try form inputs
        if (!data.language) {
          const languageEl = document.querySelector('select[name*="language"]') ||
                            document.querySelector('[data-language]');
          if (languageEl) {
            data.language = languageEl.value || languageEl.getAttribute('data-language') || '';
          }
        }

        // Try to find recovery email
        const recoveryEmailEl = document.querySelector('input[type="email"][name*="recovery"]') ||
                                document.querySelector('[data-recovery-email]');
        if (recoveryEmailEl) {
          data.recoveryEmail = recoveryEmailEl.value || recoveryEmailEl.getAttribute('data-recovery-email') || '';
        }

        // Extract Phone - structured approach
        const phoneValue = findValueAfterLabel('Phone');
        if (phoneValue) {
          // Extract phone number (remove "Add" or "Not set" text)
          const phonePattern = /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
          const phoneMatch = phoneValue.match(phonePattern);
          if (phoneMatch && !phoneValue.toLowerCase().includes('not set') && !phoneValue.toLowerCase().includes('add')) {
            data.phoneNumber = phoneMatch[0];
          }
        }
        
        // Fallback: try form inputs
        if (!data.phoneNumber) {
          const phoneEl = document.querySelector('input[type="tel"]') ||
                         document.querySelector('input[name*="phone"]');
          if (phoneEl) {
            data.phoneNumber = phoneEl.value || '';
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

      // Calculate age from birthday if available
      let calculatedAge = null;
      let ageBracket = null;
      if (accountData.birthday) {
        try {
          // Try to parse different date formats
          let birthDate = null;
          const dateStr = accountData.birthday.trim();
          
          // Try text format like "December 4, 1978" or "Dec 4, 1978"
          const textDateMatch = dateStr.match(/([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
          if (textDateMatch) {
            const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                              'July', 'August', 'September', 'October', 'November', 'December'];
            const monthAbbr = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const monthStr = textDateMatch[1];
            const day = parseInt(textDateMatch[2]);
            const year = parseInt(textDateMatch[3]);
            
            let monthIndex = monthNames.findIndex(m => m.toLowerCase() === monthStr.toLowerCase());
            if (monthIndex === -1) {
              monthIndex = monthAbbr.findIndex(m => m.toLowerCase() === monthStr.toLowerCase());
            }
            
            if (monthIndex !== -1 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
              birthDate = new Date(year, monthIndex, day);
            }
          }
          // Try ISO format (YYYY-MM-DD)
          else if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            birthDate = new Date(dateStr);
          }
          // Try MM/DD/YYYY or DD/MM/YYYY
          else if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(dateStr)) {
            const parts = dateStr.split(/[\/\-]/);
            // Assume MM/DD/YYYY format (US standard)
            if (parts[0].length <= 2 && parts[1].length <= 2) {
              birthDate = new Date(`${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`);
            }
          }
          // Try YYYY/MM/DD
          else if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(dateStr)) {
            birthDate = new Date(dateStr.replace(/[\/\-]/g, '-'));
          }
          
          if (birthDate && !isNaN(birthDate.getTime())) {
            const today = new Date();
            const age = today.getFullYear() - birthDate.getFullYear();
            const monthDiff = today.getMonth() - birthDate.getMonth();
            const dayDiff = today.getDate() - birthDate.getDate();
            
            // Adjust age if birthday hasn't occurred this year
            const actualAge = monthDiff < 0 || (monthDiff === 0 && dayDiff < 0) ? age - 1 : age;
            
            if (actualAge >= 0 && actualAge <= 120) {
              calculatedAge = actualAge;
              
              // Determine age bracket
              if (actualAge < 18) {
                ageBracket = 'Under 18';
              } else if (actualAge < 25) {
                ageBracket = '18-25';
              } else if (actualAge < 35) {
                ageBracket = '25-35';
              } else if (actualAge < 45) {
                ageBracket = '35-45';
              } else if (actualAge < 55) {
                ageBracket = '45-55';
              } else if (actualAge < 65) {
                ageBracket = '55-65';
              } else {
                ageBracket = '65+';
              }
              
              console.log(`✓ Calculated age from birthday: ${actualAge} years old (${ageBracket})`);
            }
          } else {
            console.log(`⚠ Could not parse birthday format: "${dateStr}"`);
          }
        } catch (ageError) {
          console.log('Could not calculate age from birthday:', ageError.message);
        }
      }

      // Format as email-like data structure for OpenAI analysis
      // Note: location is not included - will use proxy location instead
      const formattedData = [{
        type: 'account_settings',
        email: accountData.email || '',
        name: accountData.name || accountData.displayName || '',
        birthday: accountData.birthday || '',
        calculatedAge: calculatedAge,
        ageBracket: ageBracket,
        gender: accountData.gender || '',
        language: accountData.language || '',
        recoveryEmail: accountData.recoveryEmail || '',
        phoneNumber: accountData.phoneNumber || '',
        accountCreated: accountData.accountCreated || '',
        note: 'Account settings data - includes name, birthday, gender, language, and other personal information (location from proxy)'
      }];

      console.log('Formatted account settings data:', JSON.stringify(formattedData, null, 2));
      console.log('Extracted fields summary:');
      console.log(`  - Name: ${formattedData[0].name || 'NOT FOUND'}`);
      console.log(`  - Birthday: ${formattedData[0].birthday || 'NOT FOUND'}`);
      console.log(`  - Age: ${calculatedAge ? `${calculatedAge} (${ageBracket})` : 'NOT CALCULATED'}`);
      console.log(`  - Gender: ${formattedData[0].gender || 'NOT FOUND'}`);
      console.log(`  - Location: Will use proxy location (not from personal info)`);
      console.log(`  - Language: ${formattedData[0].language || 'NOT FOUND'}`);
      console.log(`  - Email: ${formattedData[0].email || 'NOT FOUND'}`);
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
        const captchaResult = await this.handleCaptcha(page);
        
        // CRITICAL: If CAPTCHA is not solved, stop the login process
        if (!captchaResult || !captchaResult.solved) {
          const stillOnCaptcha = await page.evaluate(() => {
            return window.location.href.includes('/challenge/recaptcha') || 
                   document.querySelector('iframe[src*="recaptcha"]') !== null;
          });
          
          if (stillOnCaptcha) {
            console.error('✗ CAPTCHA solving failed after email entry');
            console.error('⚠ Cannot proceed with login - CAPTCHA must be solved first');
            throw new Error('CAPTCHA solving failed - cannot proceed with login');
          }
        }
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
          
          // Wait a bit for any error messages to appear after password entry
          await HumanEmulation.randomDelay(3000, 4000);
          
          // Check for wrong password error immediately after password entry (check multiple times)
          for (let checkAttempt = 0; checkAttempt < 3; checkAttempt++) {
            await HumanEmulation.randomDelay(1000, 2000);
            
            const wrongPasswordAfterEntry = await page.evaluate((attemptNum) => {
              // FIRST: Check if we're on TOTP/2FA challenge page - if so, password was correct!
              const url = window.location.href.toLowerCase();
              const isOnTotpChallenge = url.includes('totp') || url.includes('challenge/totp');
              
              // Check for 2FA code input fields
              const codeInputs = Array.from(document.querySelectorAll('input')).filter(input => {
                const type = (input.type || '').toLowerCase();
                const name = (input.name || '').toLowerCase();
                const id = (input.id || '').toLowerCase();
                const label = (input.getAttribute('aria-label') || '').toLowerCase();
                const placeholder = (input.placeholder || '').toLowerCase();
                const maxLength = input.maxLength;
                
                return (type === 'text' || type === 'tel' || type === 'number') &&
                       (name.includes('code') || name.includes('totp') || name.includes('verification') ||
                        id.includes('code') || id.includes('totp') || id.includes('verification') ||
                        label.includes('code') || label.includes('verification') ||
                        placeholder.includes('code') || placeholder.includes('verification')) &&
                       (maxLength === 6 || maxLength === 8 || !maxLength);
              });
              
              // If we're on TOTP challenge or have 2FA code inputs, password was correct - don't treat as wrong password
              if (isOnTotpChallenge || codeInputs.length > 0) {
                return false; // Password was correct, we just need 2FA
              }
              
              const bodyText = document.body.textContent.toLowerCase();
              const pageHTML = document.documentElement.innerHTML.toLowerCase();
              const combinedText = bodyText + ' ' + pageHTML;
              
              const errorMessages = [
                'wrong password',
                'incorrect password',
                'password is incorrect',
                'password you entered is incorrect',
                'incorrect username or password',
                'wrong password. try again',
                'couldn\'t sign you in',
                'password incorrect',
                'authentication failed',
                'invalid password',
                'the password you entered is incorrect',
                'couldn\'t verify',
                'try again',
                'incorrect',
                'wrong',
                'invalid',
                'account or password',
                'sign in failed',
                'this account has been disabled',
                'account disabled',
                'account has been locked',
                'account locked',
                'suspicious activity',
                'unusual activity',
                'password was changed',
                'your password was changed',
                'password has been changed',
                'password changed',
                'password recently changed'
              ];
              
              const hasError = errorMessages.some(msg => combinedText.includes(msg));
              
              // Check for error elements (including password changed messages)
              const errorElements = Array.from(document.querySelectorAll('[role="alert"], .error, [class*="error"], [id*="error"], [class*="invalid"], [class*="incorrect"], [class*="wrong"], [class*="changed"]'));
              const hasErrorElement = errorElements.some(el => {
                const text = (el.textContent || '').toLowerCase();
                const style = window.getComputedStyle(el);
                const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
                // Check for password changed messages or other error messages
                return isVisible && (errorMessages.some(msg => text.includes(msg)) || 
                       text.includes('password was changed') || 
                       text.includes('password changed') ||
                       text.includes('password has been changed'));
              });
              
              // Also check for red error text near password input (Google shows password changed errors there)
              const passwordInput = document.querySelector('input[type="password"]');
              if (passwordInput) {
                const passwordContainer = passwordInput.closest('div') || passwordInput.parentElement;
                if (passwordContainer) {
                  const containerText = passwordContainer.textContent.toLowerCase();
                  if (containerText.includes('password was changed') || 
                      containerText.includes('password changed') ||
                      containerText.includes('password has been changed')) {
                    return true; // Password was changed - invalid account
                  }
                }
              }
              
              // Check if we're still on password page (indicates login failed)
              const isOnPasswordPage = url.includes('accounts.google.com') && url.includes('password') && !url.includes('totp');
              const isOnSignInPage = url.includes('accounts.google.com') && (url.includes('signin') || url.includes('identifier')) && !url.includes('challenge');
              
              // Check if password input is still visible and focused (indicates we're still on password page)
              const passwordInputVisible = document.querySelector('input[type="password"]:not([style*="display: none"]):not([style*="display:none"])') !== null;
              
              // If we're still on password/signin page after multiple attempts, likely wrong password
              const stillOnPasswordPage = (isOnPasswordPage || (isOnSignInPage && passwordInputVisible)) && attemptNum >= 1;
              
              return hasError || hasErrorElement || stillOnPasswordPage;
            }, checkAttempt);
            
            if (wrongPasswordAfterEntry) {
              console.error(`✗ WRONG PASSWORD DETECTED (attempt ${checkAttempt + 1})`);
              const wrongCredentialsError = new Error('Wrong Credentials - Password is incorrect or account has been taken back');
              wrongCredentialsError.name = 'WrongCredentialsError';
              throw wrongCredentialsError;
            }
          }
          
          // Check for CAPTCHA immediately after password entry
          const captchaResult = await this.handleCaptcha(page);
          
          // CRITICAL: If CAPTCHA is not solved, stop the login process
          if (!captchaResult || !captchaResult.solved) {
            const stillOnCaptcha = await page.evaluate(() => {
              return window.location.href.includes('/challenge/recaptcha') || 
                     document.querySelector('iframe[src*="recaptcha"]') !== null;
            });
            
            if (stillOnCaptcha) {
              console.error('✗ CAPTCHA solving failed after password entry');
              console.error('⚠ Cannot proceed with login - CAPTCHA must be solved first');
              throw new Error('CAPTCHA solving failed - cannot proceed with login');
            }
          }
          
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

      // Check for wrong password/credentials error after navigation (check multiple times with delays)
      for (let checkAttempt = 0; checkAttempt < 3; checkAttempt++) {
        await HumanEmulation.randomDelay(2000, 3000);
        
        const wrongPasswordDetected = await page.evaluate(() => {
          // FIRST: Check if we're on TOTP/2FA challenge page - if so, password was correct!
          const url = window.location.href.toLowerCase();
          const isOnTotpChallenge = url.includes('totp') || url.includes('challenge/totp');
          
          // Check for 2FA code input fields
          const codeInputs = Array.from(document.querySelectorAll('input')).filter(input => {
            const type = (input.type || '').toLowerCase();
            const name = (input.name || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            const label = (input.getAttribute('aria-label') || '').toLowerCase();
            const placeholder = (input.placeholder || '').toLowerCase();
            const maxLength = input.maxLength;
            
            return (type === 'text' || type === 'tel' || type === 'number') &&
                   (name.includes('code') || name.includes('totp') || name.includes('verification') ||
                    id.includes('code') || id.includes('totp') || id.includes('verification') ||
                    label.includes('code') || label.includes('verification') ||
                    placeholder.includes('code') || placeholder.includes('verification')) &&
                   (maxLength === 6 || maxLength === 8 || !maxLength);
          });
          
          // If we're on TOTP challenge or have 2FA code inputs, password was correct - don't treat as wrong password
          if (isOnTotpChallenge || codeInputs.length > 0) {
            return false; // Password was correct, we just need 2FA
          }
          
          const bodyText = document.body.textContent.toLowerCase();
          const pageHTML = document.documentElement.innerHTML.toLowerCase();
          const combinedText = bodyText + ' ' + pageHTML;
          
          const errorMessages = [
            'wrong password',
            'incorrect password',
            'password is incorrect',
            'password you entered is incorrect',
            'incorrect username or password',
            'wrong password. try again',
            'couldn\'t sign you in',
            'password incorrect',
            'authentication failed',
            'invalid password',
            'the password you entered is incorrect',
            'couldn\'t verify',
            'try again',
            'incorrect',
            'wrong',
            'invalid',
            'account or password',
            'sign in failed',
            'this account has been disabled',
            'account disabled',
            'account has been locked',
            'account locked',
            'suspicious activity',
            'unusual activity',
            'password was changed',
            'your password was changed',
            'password has been changed',
            'password changed',
            'password recently changed'
          ];
          
          // Check for error messages in page text
          const hasError = errorMessages.some(msg => combinedText.includes(msg));
          
          // Also check for error elements (Google typically shows errors in specific divs)
          const errorElements = Array.from(document.querySelectorAll('[role="alert"], .error, [class*="error"], [id*="error"], [class*="invalid"], [class*="incorrect"], [class*="wrong"], [class*="changed"]'));
          const hasErrorElement = errorElements.some(el => {
            const text = (el.textContent || '').toLowerCase();
            const style = window.getComputedStyle(el);
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            // Check for password changed messages or other error messages
            return isVisible && (errorMessages.some(msg => text.includes(msg)) || 
                   text.includes('password was changed') || 
                   text.includes('password changed') ||
                   text.includes('password has been changed'));
          });
          
          // Also check for red error text near password input (Google shows password changed errors there)
          const passwordInput = document.querySelector('input[type="password"]');
          if (passwordInput) {
            const passwordContainer = passwordInput.closest('div') || passwordInput.parentElement;
            if (passwordContainer) {
              const containerText = passwordContainer.textContent.toLowerCase();
              if (containerText.includes('password was changed') || 
                  containerText.includes('password changed') ||
                  containerText.includes('password has been changed')) {
                return true; // Password was changed - invalid account
              }
            }
          }
          
          // Check if we're still on login/password page (indicates login failed)
          const isOnPasswordPage = url.includes('accounts.google.com') && url.includes('password') && !url.includes('totp');
          const isOnSignInPage = url.includes('accounts.google.com') && (url.includes('signin') || url.includes('identifier')) && !url.includes('challenge');
          
          // Check if password input is still visible (indicates we're still on password page)
          const passwordInputVisible = document.querySelector('input[type="password"]:not([style*="display: none"]):not([style*="display:none"])') !== null;
          
          // If we're still on password/signin page after multiple attempts, likely wrong password
          const stillOnPasswordPage = (isOnPasswordPage || (isOnSignInPage && passwordInputVisible)) && checkAttempt >= 1;
          
          return hasError || hasErrorElement || stillOnPasswordPage;
        });
        
        if (wrongPasswordDetected) {
          console.error(`✗ WRONG PASSWORD DETECTED after navigation (attempt ${checkAttempt + 1})`);
          const wrongCredentialsError = new Error('Wrong Credentials - Password is incorrect or account has been taken back');
          wrongCredentialsError.name = 'WrongCredentialsError';
          throw wrongCredentialsError;
        }
      }

      // Immediately check if we're on TOTP/2FA page after password entry
      // This ensures we handle 2FA before other checks
      const pageUrlAfterPassword = await page.url();
      const isOnTotpPage = pageUrlAfterPassword.toLowerCase().includes('totp') || pageUrlAfterPassword.toLowerCase().includes('challenge/totp');
      
      if (isOnTotpPage) {
        console.log('✓ TOTP challenge page detected immediately after password entry');
        console.log('  - Password was correct, proceeding with 2FA verification...');
        
        // Check for 2FA code input to confirm
        const has2FAInput = await page.evaluate(() => {
          const codeInputs = Array.from(document.querySelectorAll('input')).filter(input => {
            const type = (input.type || '').toLowerCase();
            const name = (input.name || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            const label = (input.getAttribute('aria-label') || '').toLowerCase();
            const placeholder = (input.placeholder || '').toLowerCase();
            const maxLength = input.maxLength;
            
            return (type === 'text' || type === 'tel' || type === 'number') &&
                   (name.includes('code') || name.includes('totp') || name.includes('verification') ||
                    id.includes('code') || id.includes('totp') || id.includes('verification') ||
                    label.includes('code') || label.includes('verification') ||
                    placeholder.includes('code') || placeholder.includes('verification')) &&
                   (maxLength === 6 || maxLength === 8 || !maxLength);
          });
          return codeInputs.length > 0;
        });
        
        if (has2FAInput) {
          console.log('  ✓ Confirmed: 2FA code input field found');
          try {
            await this.handle2FAVerification(page, profile);
            console.log('  ✓ 2FA verification completed successfully');
            await HumanEmulation.randomDelay(3000, 5000);
            // Skip to end of login - 2FA was handled
            return;
          } catch (twoFactorError) {
            console.error('  ✗ 2FA verification failed:', twoFactorError.message);
            throw twoFactorError;
          }
        }
      }

      // Check for CAPTCHA before other challenges
      const captchaResult = await this.handleCaptcha(page);
      
      // If CAPTCHA is still present and not solved, stop the login process
      if (!captchaResult || !captchaResult.solved) {
        const stillOnCaptcha = await page.evaluate(() => {
          return window.location.href.includes('/challenge/recaptcha') || 
                 document.querySelector('iframe[src*="recaptcha"]') !== null;
        });
        
        if (stillOnCaptcha) {
          console.error('');
          console.error('✗✗✗ CAPTCHA SOLVING FAILED ✗✗✗');
          console.error('⚠ Cannot proceed with login - CAPTCHA must be solved first');
          console.error('The system will NOT continue to SMS verification or other steps.');
          console.error('Please solve CAPTCHA manually or fix the CAPTCHA service configuration.');
          console.error('');
          const captchaError = new Error('CAPTCHA solving failed - cannot proceed with login. Please solve CAPTCHA manually.');
          captchaError.name = 'CAPTCHAFailedError';
          throw captchaError;
        }
      }

      // Check for recovery email selection screen
      await this.handleRecoveryEmailSelection(page, profile);
      
      // Check again for "Verify it's you" screen with recovery email confirmation option (in case it appeared later)
      await this.handleRecoveryEmailVerification(page, profile);
      
      // Check for Google account recovery settings page ("Make sure you can always sign in")
      await this.handleRecoverySettingsPage(page, profile);
      
      // Check for 2FA (Two-Factor Authentication) prompt FIRST (before SMS)
      // 2FA accounts should use authenticator codes instead of SMS
      const twoFactorPrompt = await page.evaluate(() => {
        const bodyText = document.body.textContent.toLowerCase();
        const url = window.location.href.toLowerCase();
        
        // Check for 2FA/authenticator prompts
        const has2FAPrompt = /enter.*verification.*code|code.*from.*authenticator|google.*authenticator|verification.*code|2-step|two-step|two.*factor/i.test(bodyText);
        
        // Check for 6-digit code input fields (typical for 2FA)
        const codeInputs = Array.from(document.querySelectorAll('input')).filter(input => {
          const type = input.type.toLowerCase();
          const name = (input.name || '').toLowerCase();
          const id = (input.id || '').toLowerCase();
          const label = (input.getAttribute('aria-label') || '').toLowerCase();
          const placeholder = (input.placeholder || '').toLowerCase();
          const maxLength = input.maxLength;
          
          return (type === 'text' || type === 'tel' || type === 'number') &&
                 (name.includes('code') || name.includes('totp') || name.includes('verification') ||
                  id.includes('code') || id.includes('totp') || id.includes('verification') ||
                  label.includes('code') || label.includes('verification') ||
                  placeholder.includes('code') || placeholder.includes('verification')) &&
                 (maxLength === 6 || maxLength === 8 || !maxLength);
        });
        
        // Check URL for 2FA/challenge indicators
        const is2FAChallenge = url.includes('challenge') && (has2FAPrompt || codeInputs.length > 0);
        const isTotpUrl = url.includes('totp') || url.includes('challenge/totp');
        
        return {
          has2FAPrompt,
          codeInputCount: codeInputs.length,
          is2FAChallenge,
          isTotpUrl,
          url
        };
      });
      
      // If URL contains TOTP, we're definitely on 2FA page (password was correct)
      if (twoFactorPrompt.isTotpUrl || twoFactorPrompt.has2FAPrompt || twoFactorPrompt.codeInputCount > 0) {
        console.log('2FA (Two-Factor Authentication) prompt detected...');
        console.log(`  - URL contains TOTP: ${twoFactorPrompt.isTotpUrl}`);
        console.log(`  - Has 2FA prompt text: ${twoFactorPrompt.has2FAPrompt}`);
        console.log(`  - Code input fields found: ${twoFactorPrompt.codeInputCount}`);
        if (twoFactorPrompt.isTotpUrl) {
          console.log('  ✓ TOTP challenge detected - password was correct, proceeding with 2FA...');
        }
        
        try {
          await this.handle2FAVerification(page, profile);
        } catch (twoFactorError) {
          console.log('2FA verification failed:', twoFactorError.message);
          console.log('Checking for alternative verification methods...');
          await this.tryAlternativeVerification(page);
        }
        
        await HumanEmulation.randomDelay(3000, 5000);
      }
      
      // Check if already logged in to Gmail (via cookies) - skip SMS verification if logged in
      const isLoggedIn = await page.evaluate(() => {
        const url = window.location.href.toLowerCase();
        const bodyText = document.body.textContent.toLowerCase();
        
        // Check if we're on Gmail inbox or mail.google.com
        const isGmailInbox = url.includes('mail.google.com') && 
                            (url.includes('/mail/') || url.includes('/u/') || !url.includes('/accounts/'));
        
        // Check for Gmail inbox indicators
        const hasInboxIndicators = /inbox|compose|search mail|primary|social|promotions/i.test(bodyText);
        
        // Check for email list or conversation view
        const hasEmailList = document.querySelector('[role="main"]') || 
                            document.querySelector('[role="list"]') ||
                            document.querySelector('[data-thread-perm-id]');
        
        return isGmailInbox || (hasInboxIndicators && hasEmailList);
      });
      
      let phoneNumberPrompt = { hasPhonePrompt: false, phoneInputCount: 0 };
      
      if (isLoggedIn) {
        console.log('✓ Already logged in to Gmail (via cookies) - skipping SMS verification');
        console.log('  - Login successful without verification needed');
      } else {
        // Check for another "Verify it's you" screen with 2FA code prompt (Google sometimes shows this after first 2FA)
        const verifyItsYou = await page.evaluate(() => {
          const bodyText = document.body.textContent.toLowerCase();
          const url = window.location.href.toLowerCase();
          
          // Check for "Verify it's you" text
          const hasVerifyText = /verify.*it.*you|verify.*your.*identity/i.test(bodyText);
          
          // Check for "Get a verification code from the Google Authenticator app" text
          const hasAuthenticatorText = /get.*verification.*code.*from.*google.*authenticator|google.*authenticator.*app/i.test(bodyText);
          
          // Check for code input fields (not phone inputs)
          const codeInputs = Array.from(document.querySelectorAll('input')).filter(input => {
            const type = input.type.toLowerCase();
            const name = (input.name || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            const label = (input.getAttribute('aria-label') || '').toLowerCase();
            const placeholder = (input.placeholder || '').toLowerCase();
            const maxLength = input.maxLength;
            
            // Exclude phone inputs
            const isPhoneInput = type === 'tel' || 
                               name.includes('phone') || 
                               id.includes('phone') || 
                               label.includes('phone') ||
                               placeholder.includes('phone');
            
            if (isPhoneInput) return false;
            
            return (type === 'text' || type === 'number') &&
                   (name.includes('code') || name.includes('totp') || name.includes('verification') ||
                    id.includes('code') || id.includes('totp') || id.includes('verification') ||
                    label.includes('code') || label.includes('verification') ||
                    placeholder.includes('code') || placeholder.includes('verification')) &&
                   (maxLength === 6 || maxLength === 8 || !maxLength);
          });
          
          return {
            hasVerifyText,
            hasAuthenticatorText,
            codeInputCount: codeInputs.length,
            isVerifyScreen: hasVerifyText && (hasAuthenticatorText || codeInputs.length > 0)
          };
        });
        
        if (verifyItsYou.isVerifyScreen) {
          console.log('✓ Another "Verify it\'s you" screen detected - handling as 2FA (not SMS)');
          console.log(`  - Has verify text: ${verifyItsYou.hasVerifyText}`);
          console.log(`  - Has authenticator text: ${verifyItsYou.hasAuthenticatorText}`);
          console.log(`  - Code input fields found: ${verifyItsYou.codeInputCount}`);
          console.log('  - This is a 2FA code prompt, NOT a phone number prompt - skipping SMS rental');
          
          try {
            await this.handle2FAVerification(page, profile);
            await HumanEmulation.randomDelay(3000, 5000);
          } catch (verifyError) {
            console.log('Second 2FA verification failed:', verifyError.message);
            // Continue - don't block login flow
          }
        } else {
          // Check for phone number prompt (SMS verification) - only if NOT a "Verify it's you" screen
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
            // Double-check that phone input field actually exists and is visible before renting
            const phoneInputExists = await page.evaluate(() => {
              const phoneInputs = Array.from(document.querySelectorAll('input')).filter(input => {
                const type = input.type.toLowerCase();
                const name = (input.name || '').toLowerCase();
                const id = (input.id || '').toLowerCase();
                const label = (input.getAttribute('aria-label') || '').toLowerCase();
                const placeholder = (input.placeholder || '').toLowerCase();
                const isPhoneInput = type === 'tel' || 
                                   name.includes('phone') || 
                                   id.includes('phone') || 
                                   label.includes('phone') ||
                                   placeholder.includes('phone');
                
                if (!isPhoneInput) return false;
                
                // Check if input is visible and not disabled
                const rect = input.getBoundingClientRect();
                const style = window.getComputedStyle(input);
                const isVisible = rect.width > 0 && rect.height > 0 && 
                                style.display !== 'none' && 
                                style.visibility !== 'hidden' &&
                                !input.disabled &&
                                input.offsetParent !== null;
                
                return isVisible;
              });
              
              return phoneInputs.length > 0;
            });
            
            if (!phoneInputExists) {
              console.log('⚠ Phone prompt text detected but no visible phone input field found - skipping SMS verification');
              console.log('  - This may be a recovery settings page that doesn\'t require phone verification');
              return;
            }
            
            console.log('Phone number prompt detected - attempting SMS verification...');
            console.log(`  - Has phone prompt text: ${phoneNumberPrompt.hasPhonePrompt}`);
            console.log(`  - Phone input fields found: ${phoneNumberPrompt.phoneInputCount}`);
            console.log(`  - Visible phone input field confirmed: ${phoneInputExists}`);
            
            try {
              await this.handleSMSVerification(page);
            } catch (smsError) {
              console.log('SMS verification failed:', smsError.message);
              console.log('Checking for alternative verification methods...');
              await this.tryAlternativeVerification(page);
            }
            
            await HumanEmulation.randomDelay(3000, 5000);
          }
        }
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
      if (verifyChallenge && phoneNumberPrompt && !phoneNumberPrompt.hasPhonePrompt) {
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

  async handleRecoverySettingsPage(page, profile) {
    try {
      // Wait a bit for page to load
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Check if we're on the Google account recovery settings page
      const isRecoverySettingsPage = await page.evaluate(() => {
        const bodyText = document.body.textContent.toLowerCase();
        const url = window.location.href.toLowerCase();
        const title = document.title.toLowerCase();
        
        // Check for the specific heading "Make sure you can always sign in"
        const hasHeading = /make sure you can always sign in/i.test(bodyText);
        
        // Check for recovery settings indicators
        const hasRecoverySettings = /recovery.*info|recovery.*phone|recovery.*email|add.*recovery/i.test(bodyText);
        
        // Check URL for account/recovery settings
        const isSettingsUrl = url.includes('accounts.google.com') && 
                             (url.includes('signinoptions') || url.includes('recovery') || url.includes('security'));
        
        // Look for Save button
        const saveButtons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
          .filter(btn => {
            const text = (btn.textContent || btn.value || '').toLowerCase().trim();
            return text === 'save' || text === 'save changes';
          });
        
        return {
          url,
          title,
          hasHeading,
          hasRecoverySettings,
          isSettingsUrl,
          hasSaveButton: saveButtons.length > 0,
          saveButtonCount: saveButtons.length,
          isRecoverySettingsPage: hasHeading && hasRecoverySettings
        };
      });
      
      if (!isRecoverySettingsPage.isRecoverySettingsPage) {
        console.log('No recovery settings page detected');
        return;
      }
      
      console.log('✓ Recovery settings page detected ("Make sure you can always sign in")');
      console.log('  - Clicking Cancel to skip recovery settings...');
      
      // Find and click the Cancel button instead of Save
      const cancelButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, span, div'));
        return buttons.find(btn => {
          const text = (btn.textContent || btn.value || '').toLowerCase().trim();
          const isVisible = window.getComputedStyle(btn).display !== 'none' && 
                           window.getComputedStyle(btn).visibility !== 'hidden' &&
                           window.getComputedStyle(btn).opacity !== '0';
          // Look for Cancel button - can be text button or link
          return text === 'cancel' && isVisible;
        });
      });
      
      if (cancelButton && cancelButton.asElement()) {
        console.log('Found Cancel button, clicking...');
        
        // Add human-like delay before clicking
        await HumanEmulation.randomDelay(1000, 2000);
        
        // Move mouse to button with human-like movement
        try {
          const buttonBounds = await cancelButton.asElement().boundingBox();
          if (buttonBounds) {
            await HumanEmulation.moveMouse(
              page,
              buttonBounds.x + buttonBounds.width / 2,
              buttonBounds.y + buttonBounds.height / 2,
              buttonBounds.x + buttonBounds.width / 2,
              buttonBounds.y + buttonBounds.height / 2
            );
            await HumanEmulation.randomDelay(300, 600);
          }
        } catch (mouseError) {
          console.log('Could not move mouse to Cancel button:', mouseError.message);
        }
        
        await cancelButton.asElement().click({ delay: 100 + Math.random() * 100 });
        console.log('✓ Clicked Cancel button');
        
        // Wait for navigation after clicking Cancel
        await HumanEmulation.randomDelay(2000, 3000);
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
          console.log('✓ Navigation after Cancel completed');
        } catch (navError) {
          console.log('Navigation timeout after Cancel - may have already navigated');
        }
      } else {
        // Try alternative method - find Cancel by text content
        const cancelClicked = await page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('button, [role="button"], a, span, div'));
          for (const el of allElements) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (text === 'cancel') {
              const style = window.getComputedStyle(el);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                try {
                  el.click();
                  return true;
                } catch (e) {
                  // Try parent if click fails
                  const parent = el.parentElement;
                  if (parent && (parent.tagName === 'BUTTON' || parent.getAttribute('role') === 'button')) {
                    parent.click();
                    return true;
                  }
                }
              }
            }
          }
          return false;
        });
        
        if (cancelClicked) {
          console.log('✓ Clicked Cancel button using fallback method');
          await HumanEmulation.randomDelay(2000, 3000);
        } else {
          console.log('⚠ Could not find Cancel button - page may need manual intervention');
        }
      }
      
    } catch (error) {
      console.error('Error handling recovery settings page:', error.message);
      // Don't throw - recovery settings page handling is not critical for login
    }
  }

  async handleGmailAppUpgradePage(page, profile) {
    try {
      // Wait a bit for page to load
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Check if we're on the "Upgrade to the Gmail app" page
      const isGmailAppPage = await page.evaluate(() => {
        const bodyText = document.body.textContent || '';
        const url = window.location.href.toLowerCase();
        const title = document.title.toLowerCase();
        
        // Check for Gmail app upgrade page indicators
        const hasUpgradeTitle = /upgrade.*gmail.*app/i.test(bodyText) || /upgrade.*to.*gmail.*app/i.test(bodyText);
        const hasWebVersionLink = /use.*web.*version/i.test(bodyText);
        const hasAppFeatures = /access.*email.*one.*click|get.*notified.*new.*mail|add.*non.*gmail.*accounts/i.test(bodyText);
        
        // Look for "Use the web version" link/button
        const webVersionLinks = Array.from(document.querySelectorAll('a, button, [role="button"], span, div'))
          .filter(el => {
            const text = (el.textContent || el.innerText || '').toLowerCase().trim();
            return /use.*web.*version/i.test(text) || text === 'use the web version';
          });
        
        return {
          url,
          hasUpgradeTitle,
          hasWebVersionLink,
          hasAppFeatures,
          hasWebVersionButton: webVersionLinks.length > 0,
          webVersionButtonCount: webVersionLinks.length,
          isGmailAppPage: hasUpgradeTitle && hasWebVersionLink
        };
      });
      
      if (!isGmailAppPage.isGmailAppPage) {
        return;
      }
      
      console.log('✓ Gmail app upgrade page detected ("Upgrade to the Gmail app")');
      console.log(`  - Found ${isGmailAppPage.webVersionButtonCount} "Use the web version" link(s)`);
      
      // Click "Use the web version" link
      const webVersionClicked = await page.evaluate(() => {
        // Try to find "Use the web version" link/button
        const allElements = Array.from(document.querySelectorAll('a, button, [role="button"], span, div'));
        
        for (const el of allElements) {
          const text = (el.textContent || el.innerText || '').toLowerCase().trim();
          // Match "Use the web version" or similar
          if (/use.*web.*version/i.test(text) || text === 'use the web version') {
            // Check if element is visible
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isVisible = rect.width > 0 && rect.height > 0 && 
                            style.display !== 'none' && 
                            style.visibility !== 'hidden' &&
                            el.offsetParent !== null;
            
            if (isVisible) {
              // Try to click the element or find a clickable parent
              let clickable = el;
              for (let i = 0; i < 3; i++) {
                if (clickable.tagName === 'A' || clickable.tagName === 'BUTTON' || 
                    clickable.getAttribute('role') === 'button' || clickable.onclick !== null ||
                    clickable.style.cursor === 'pointer') {
                  clickable.click();
                  return true;
                }
                clickable = clickable.parentElement;
                if (!clickable || clickable === document.body) break;
              }
              // If no clickable parent found, try clicking the element directly
              try {
                el.click();
                return true;
              } catch (e) {
                // Continue to next element
              }
            }
          }
        }
        return false;
      });
      
      if (webVersionClicked) {
        console.log('✓ Clicked "Use the web version" link');
        
        // Wait for navigation or page update
        await HumanEmulation.randomDelay(2000, 3000);
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
          console.log('✓ Navigation after clicking "Use the web version" completed');
        } catch (navError) {
          console.log('Navigation timeout after clicking "Use the web version" - may have already navigated');
        }
      } else {
        // Try alternative method: find by text content using Puppeteer
        try {
          const webVersionLink = await page.evaluateHandle(() => {
            const allElements = Array.from(document.querySelectorAll('a, button, [role="button"], span, div'));
            for (const el of allElements) {
              const text = (el.textContent || el.innerText || '').toLowerCase().trim();
              if (/use.*web.*version/i.test(text) && el.offsetParent !== null) {
                return el;
              }
            }
            return null;
          });
          
          if (webVersionLink && webVersionLink.asElement()) {
            await webVersionLink.asElement().click();
            console.log('✓ Clicked "Use the web version" link using alternative method');
            await HumanEmulation.randomDelay(2000, 3000);
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
          } else {
            console.log('⚠ "Use the web version" link not found on Gmail app upgrade page');
          }
        } catch (altError) {
          console.log('⚠ Could not click "Use the web version" link:', altError.message);
        }
      }
      
    } catch (error) {
      console.error('Error handling Gmail app upgrade page:', error.message);
      // Don't throw - Gmail app upgrade page handling is not critical
    }
  }

  async handleGmailAppUpgradePage(page, profile) {
    try {
      // Wait a bit for page to load
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Check if we're on the "Upgrade to the Gmail app" page
      const isGmailAppPage = await page.evaluate(() => {
        const bodyText = document.body.textContent || '';
        const url = window.location.href.toLowerCase();
        
        // Check for Gmail app upgrade page indicators
        const hasUpgradeTitle = /upgrade.*gmail.*app/i.test(bodyText) || /upgrade.*to.*gmail.*app/i.test(bodyText);
        const hasWebVersionLink = /use.*web.*version/i.test(bodyText);
        const hasAppFeatures = /access.*email.*one.*click|get.*notified.*new.*mail|add.*non.*gmail.*accounts/i.test(bodyText);
        
        // Look for "Use the web version" link/button
        const webVersionLinks = Array.from(document.querySelectorAll('a, button, [role="button"], span, div'))
          .filter(el => {
            const text = (el.textContent || el.innerText || '').toLowerCase().trim();
            return /use.*web.*version/i.test(text) || text === 'use the web version';
          });
        
        return {
          url,
          hasUpgradeTitle,
          hasWebVersionLink,
          hasAppFeatures,
          hasWebVersionButton: webVersionLinks.length > 0,
          webVersionButtonCount: webVersionLinks.length,
          isGmailAppPage: hasUpgradeTitle && hasWebVersionLink
        };
      });
      
      if (!isGmailAppPage.isGmailAppPage) {
        return;
      }
      
      console.log('✓ Gmail app upgrade page detected ("Upgrade to the Gmail app")');
      console.log(`  - Found ${isGmailAppPage.webVersionButtonCount} "Use the web version" link(s)`);
      
      // Click "Use the web version" link
      const webVersionClicked = await page.evaluate(() => {
        // Try to find "Use the web version" link/button
        const allElements = Array.from(document.querySelectorAll('a, button, [role="button"], span, div'));
        
        for (const el of allElements) {
          const text = (el.textContent || el.innerText || '').toLowerCase().trim();
          // Match "Use the web version" or similar
          if (/use.*web.*version/i.test(text) || text === 'use the web version') {
            // Check if element is visible
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isVisible = rect.width > 0 && rect.height > 0 && 
                            style.display !== 'none' && 
                            style.visibility !== 'hidden' &&
                            el.offsetParent !== null;
            
            if (isVisible) {
              // Try to click the element or find a clickable parent
              let clickable = el;
              for (let i = 0; i < 3; i++) {
                if (clickable.tagName === 'A' || clickable.tagName === 'BUTTON' || 
                    clickable.getAttribute('role') === 'button' || clickable.onclick !== null ||
                    clickable.style.cursor === 'pointer') {
                  clickable.click();
                  return true;
                }
                clickable = clickable.parentElement;
                if (!clickable || clickable === document.body) break;
              }
              // If no clickable parent found, try clicking the element directly
              try {
                el.click();
                return true;
              } catch (e) {
                // Continue to next element
              }
            }
          }
        }
        return false;
      });
      
      if (webVersionClicked) {
        console.log('✓ Clicked "Use the web version" link');
        
        // Wait for navigation or page update
        await HumanEmulation.randomDelay(2000, 3000);
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
          console.log('✓ Navigation after clicking "Use the web version" completed');
        } catch (navError) {
          console.log('Navigation timeout after clicking "Use the web version" - may have already navigated');
        }
      } else {
        // Try alternative method: find by text content using Puppeteer
        try {
          const webVersionLink = await page.evaluateHandle(() => {
            const allElements = Array.from(document.querySelectorAll('a, button, [role="button"], span, div'));
            for (const el of allElements) {
              const text = (el.textContent || el.innerText || '').toLowerCase().trim();
              if (/use.*web.*version/i.test(text) && el.offsetParent !== null) {
                return el;
              }
            }
            return null;
          });
          
          if (webVersionLink && webVersionLink.asElement()) {
            await webVersionLink.asElement().click();
            console.log('✓ Clicked "Use the web version" link using alternative method');
            await HumanEmulation.randomDelay(2000, 3000);
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
          } else {
            console.log('⚠ "Use the web version" link not found on Gmail app upgrade page');
          }
        } catch (altError) {
          console.log('⚠ Could not click "Use the web version" link:', altError.message);
        }
      }
      
    } catch (error) {
      console.error('Error handling Gmail app upgrade page:', error.message);
      // Don't throw - Gmail app upgrade page handling is not critical
    }
  }

  async handleHomeAddressPage(page, profile) {
    try {
      // Wait a bit for page to load
      await HumanEmulation.randomDelay(2000, 3000);
      
      // Check if we're on the "Set a home address" page
      const isHomeAddressPage = await page.evaluate(() => {
        const bodyText = document.body.textContent.toLowerCase();
        const url = window.location.href.toLowerCase();
        const title = document.title.toLowerCase();
        
        // Check URL for home address page
        const isHomeAddressUrl = url.includes('homeaddress') || url.includes('home-address') || url.includes('set-home-address');
        
        // Check for the specific heading "Set a home address"
        const hasHeading = /set.*home.*address/i.test(bodyText) || /set.*a.*home.*address/i.test(bodyText);
        
        // Check for home address input field
        const hasAddressInput = /home.*address|address.*input/i.test(bodyText);
        
        // Look for Skip button
        const skipButtons = Array.from(document.querySelectorAll('button, [role="button"], a, span'))
          .filter(btn => {
            const text = (btn.textContent || btn.innerText || '').toLowerCase().trim();
            return text === 'skip' || text === 'skip for now' || text.includes('skip');
          });
        
        return {
          url,
          isHomeAddressUrl,
          hasHeading,
          hasAddressInput,
          hasSkipButton: skipButtons.length > 0,
          skipButtonCount: skipButtons.length,
          isHomeAddressPage: (isHomeAddressUrl || hasHeading) && hasAddressInput
        };
      });
      
      if (!isHomeAddressPage.isHomeAddressPage) {
        console.log('No home address page detected');
        return;
      }
      
      console.log('✓ Home address page detected ("Set a home address")');
      console.log(`  - Found ${isHomeAddressPage.skipButtonCount} Skip button(s)`);
      
      // Click the Skip button
      const skipClicked = await page.evaluate(() => {
        // Try to find Skip button - check buttons, links, and spans
        const allElements = Array.from(document.querySelectorAll('button, [role="button"], a, span, div'));
        
        for (const el of allElements) {
          const text = (el.textContent || el.innerText || '').toLowerCase().trim();
          // Match "Skip" exactly or as part of text (but not "skip to" or similar)
          if (text === 'skip' || (text.includes('skip') && text.length < 20 && !text.includes('skip to'))) {
            // Check if element is visible and clickable
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isVisible = rect.width > 0 && rect.height > 0 && 
                            style.display !== 'none' && 
                            style.visibility !== 'hidden' &&
                            el.offsetParent !== null;
            
            if (isVisible) {
              // Try to click the element or find a clickable parent
              let clickable = el;
              for (let i = 0; i < 3; i++) {
                if (clickable.tagName === 'BUTTON' || clickable.tagName === 'A' || 
                    clickable.getAttribute('role') === 'button' || clickable.onclick !== null) {
                  clickable.click();
                  return true;
                }
                clickable = clickable.parentElement;
                if (!clickable || clickable === document.body) break;
              }
              // If no clickable parent found, try clicking the element directly
              try {
                el.click();
                return true;
              } catch (e) {
                // Continue to next element
              }
            }
          }
        }
        return false;
      });
      
      if (skipClicked) {
        console.log('✓ Clicked Skip button on home address page');
        
        // Wait for navigation or page update
        await HumanEmulation.randomDelay(2000, 3000);
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
          console.log('✓ Navigation after Skip completed');
        } catch (navError) {
          console.log('Navigation timeout after Skip - may have already navigated');
        }
      } else {
        // Try alternative method: find by text content
        try {
          const skipButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
            for (const btn of buttons) {
              const text = (btn.textContent || btn.innerText || '').toLowerCase().trim();
              if ((text === 'skip' || text === 'skip for now') && btn.offsetParent !== null) {
                return btn;
              }
            }
            return null;
          });
          
          if (skipButton && skipButton.asElement()) {
            await skipButton.asElement().click();
            console.log('✓ Clicked Skip button using alternative method');
            await HumanEmulation.randomDelay(2000, 3000);
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
          } else {
            console.log('⚠ Skip button not found on home address page');
          }
        } catch (altError) {
          console.log('⚠ Could not click Skip button:', altError.message);
        }
      }
      
    } catch (error) {
      console.error('Error handling home address page:', error.message);
      // Don't throw - home address page handling is not critical for login
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
        const authenticatorClicked = await page.evaluate(() => {
          const bodyText = (document.body.textContent || '').toLowerCase();
          const hasAuthText = bodyText.includes('google authenticator') || bodyText.includes('authenticator app');
          if (!hasAuthText) return { success: false };
          const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span, li'));
          for (const el of nodes) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (!text) continue;
            if (text.includes('google authenticator') || text.includes('authenticator app') || text.includes('verification code')) {
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
              try {
                el.scrollIntoView({ block: 'center' });
                el.click();
                return { success: true, text: text.substring(0, 80) };
              } catch (e) {}
            }
          }
          return { success: false };
        });
        if (authenticatorClicked && authenticatorClicked.success) {
          console.log(`✓ Selected authenticator verification option: ${authenticatorClicked.text}`);
          await HumanEmulation.randomDelay(2000, 3000);
        }
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
      
      if (!this.captchaService.apiKey) {
        console.log('No CAPTCHA service API key configured, skipping CAPTCHA solving');
        console.log('Please configure at least one in .env file:');
        console.log('  - CAPMONSTER_API_KEY');
        console.log('  - ANTICAPTCHA_API_KEY');
        console.log('  - TWOCAPTCHA_API_KEY');
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

      // For checkbox and image challenges, we need to click the checkbox first to trigger the challenge
      // Then the CAPTCHA service will solve the image challenge automatically
      
      // Check if there's a visible checkbox that needs to be clicked
      const hasCheckboxChallenge = await page.evaluate(() => {
        const checkbox = document.querySelector('.recaptcha-checkbox, .recaptcha-checkbox-border, [role="checkbox"]');
        const checkboxIframe = document.querySelector('iframe[src*="recaptcha"][title*="recaptcha"]');
        return checkbox !== null || checkboxIframe !== null;
      });

      // If checkbox challenge is present, click it first to trigger the image challenge
      if (hasCheckboxChallenge) {
        console.log('Checkbox challenge detected - clicking checkbox to trigger image challenge...');
        try {
          const checkboxSelectors = [
            '.recaptcha-checkbox',
            '.recaptcha-checkbox-border',
            '[role="checkbox"]',
            'div[class*="recaptcha-checkbox"]'
          ];
          
          let checkboxClicked = false;
          for (const selector of checkboxSelectors) {
            try {
              const checkbox = await page.$(selector);
              if (checkbox) {
                await checkbox.click({ delay: 200 + Math.random() * 300 });
                console.log(`✓ Clicked checkbox to trigger challenge (${selector})`);
                checkboxClicked = true;
                await HumanEmulation.randomDelay(2000, 3000); // Wait for challenge to appear
                break;
              }
            } catch (e) {
              continue;
            }
          }
          
          // If direct click failed, try clicking via iframe
          if (!checkboxClicked) {
            try {
              const checkboxIframe = await page.$('iframe[src*="recaptcha"][title*="recaptcha"]');
              if (checkboxIframe) {
                const frame = await checkboxIframe.contentFrame();
                if (frame) {
                  const checkbox = await frame.$('.recaptcha-checkbox, [role="checkbox"]');
                  if (checkbox) {
                    await checkbox.click({ delay: 200 + Math.random() * 300 });
                    console.log('✓ Clicked checkbox via iframe');
                    await HumanEmulation.randomDelay(2000, 3000);
                  }
                }
              }
            } catch (e) {
              console.log('Could not click checkbox via iframe:', e.message);
            }
          }
        } catch (e) {
          console.log('Error clicking checkbox:', e.message);
          console.log('Continuing with CAPTCHA service solving (it may handle the click automatically)');
        }
      }

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
          solution = await this.captchaService.solveReCaptchaV2(captchaInfo.currentUrl, captchaInfo.siteKey);
        } else if (captchaInfo.captchaType === 'recaptcha-v3') {
          console.log('Note: reCAPTCHA v3 may take longer to solve (up to 5 minutes). Please wait...');
          solution = await this.captchaService.solveReCaptchaV3(captchaInfo.currentUrl, captchaInfo.siteKey, 'verify');
        } else if (captchaInfo.captchaType === 'hcaptcha') {
          solution = await this.captchaService.solveHCaptcha(captchaInfo.currentUrl, captchaInfo.siteKey);
        } else {
          console.log('Unknown CAPTCHA type, trying reCAPTCHA v2 (most common)...');
          // Validate site key again before attempting
          if (captchaInfo.siteKey && captchaInfo.siteKey.length >= 20 && 
              captchaInfo.siteKey !== 'explicit' && 
              !captchaInfo.siteKey.toLowerCase().includes('explicit')) {
            solution = await this.captchaService.solveReCaptchaV2(captchaInfo.currentUrl, captchaInfo.siteKey);
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
            solution = await this.captchaService.solveReCaptchaV2(captchaInfo.currentUrl, captchaInfo.siteKey);
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
      
      // Human-like behavior: Simulate reading/thinking before injecting
      console.log('Simulating human reading before injecting token...');
      await HumanEmulation.simulateReading(page, 2000 + Math.random() * 3000); // 2-5 seconds of reading
      
      // Add some random mouse movements to simulate human interaction
      try {
        const viewport = page.viewport();
        if (viewport) {
          const randomX = Math.random() * viewport.width;
          const randomY = Math.random() * viewport.height;
          await HumanEmulation.moveMouse(page, viewport.width / 2, viewport.height / 2, randomX, randomY);
          await HumanEmulation.randomDelay(500, 1000);
        }
      } catch (e) {
        // Ignore mouse movement errors
      }
      
      console.log('Injecting solution into page...');
      
      // Wait a bit to ensure the page is ready (longer delay for human-like behavior)
      await HumanEmulation.randomDelay(2000, 4000);

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
        
        // Human-like behavior: Simulate reading/verifying after injection
        console.log('Simulating human verification of CAPTCHA...');
        await HumanEmulation.simulateReading(page, 2000 + Math.random() * 3000); // 2-5 seconds
        
        // Add reading jitter (small scroll movements to mimic reading)
        for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
          await HumanEmulation.readingJitter(page);
          await HumanEmulation.randomDelay(300, 800);
        }
        
        await HumanEmulation.randomDelay(2000, 4000);

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
        // Human-like behavior: Longer wait with reading simulation
        console.log('Waiting for Google to validate the token...');
        console.log('Simulating human behavior: reading page and verifying CAPTCHA...');
        
        // Simulate human reading the page
        await HumanEmulation.simulateReading(page, 4000 + Math.random() * 3000); // 4-7 seconds
        
        // Add more reading jitter (humans scroll while reading)
        for (let i = 0; i < 3 + Math.floor(Math.random() * 4); i++) {
          await HumanEmulation.readingJitter(page);
          await HumanEmulation.randomDelay(400, 1200);
        }
        
        // Additional thinking delay (humans often pause before clicking submit)
        await HumanEmulation.randomDelay(2000, 4000);

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
            
            // Human-like behavior: Move mouse to button before clicking
            try {
              const buttonBounds = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"], div[role="button"]'));
                const submitBtn = buttons.find(btn => {
                  const text = (btn.textContent || btn.value || btn.innerText || '').toLowerCase();
                  return text.includes('next') || text.includes('continue') || text.includes('verify') || text.includes('submit');
                });
                if (submitBtn) {
                  const rect = submitBtn.getBoundingClientRect();
                  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                }
                return null;
              });
              
              if (buttonBounds) {
                const viewport = page.viewport();
                if (viewport) {
                  // Move mouse to button with human-like curve
                  await HumanEmulation.moveMouse(
                    page,
                    viewport.width / 2,
                    viewport.height / 2,
                    buttonBounds.x,
                    buttonBounds.y
                  );
                  // Human pause before clicking (humans don't click immediately - they read first)
                  await HumanEmulation.randomDelay(1000, 2500);
                  
                  // Small mouse micro-movements (humans don't keep mouse perfectly still)
                  for (let i = 0; i < 2; i++) {
                    const microX = buttonBounds.x + (Math.random() - 0.5) * 10;
                    const microY = buttonBounds.y + (Math.random() - 0.5) * 10;
                    await page.mouse.move(microX, microY);
                    await HumanEmulation.randomDelay(100, 300);
                  }
                  
                  // Small mouse micro-movements (humans don't keep mouse perfectly still)
                  for (let i = 0; i < 2; i++) {
                    const microX = buttonBounds.x + (Math.random() - 0.5) * 10;
                    const microY = buttonBounds.y + (Math.random() - 0.5) * 10;
                    await page.mouse.move(microX, microY);
                    await HumanEmulation.randomDelay(100, 300);
                  }
                }
              }
            } catch (e) {
              // Ignore mouse movement errors
            }
            
            // Try to click using Puppeteer selector
            let clicked = false;
            if (nextButton.id) {
              try {
                // Human-like click with delay
                await page.click(`#${nextButton.id}`, { delay: 100 + Math.random() * 100 });
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
            
            // Human-like behavior: Small delay after clicking (humans don't move away instantly)
            await HumanEmulation.randomDelay(500, 1200);
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
        // Human-like behavior: Continue reading/checking after clicking
        console.log('Waiting for Google to validate CAPTCHA token and navigate...');
        console.log('Simulating human behavior: waiting for page response...');
        
        // Add some reading jitter while waiting (humans check the page while waiting)
        await HumanEmulation.simulateReading(page, 2000 + Math.random() * 3000);
        
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
              console.log('4. Token format/validation issue - CAPTCHA service token not compatible');
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
    
    // Wait a bit more to ensure page has updated after token injection
    await HumanEmulation.randomDelay(2000, 3000);
    
    // Return a status indicator so calling code knows if CAPTCHA was solved
    // Check multiple times to be sure
    let captchaSolved = false;
    for (let i = 0; i < 3; i++) {
      captchaSolved = await page.evaluate(() => {
        const url = window.location.href;
        const hasRecaptchaIframe = document.querySelector('iframe[src*="recaptcha"]') !== null;
        const isOnCaptchaPage = url.includes('/challenge/recaptcha');
        const checkboxChecked = document.querySelector('.recaptcha-checkbox-checked') !== null;
        
        // CAPTCHA is solved if:
        // 1. Not on CAPTCHA page AND
        // 2. No reCAPTCHA iframe present OR checkbox is checked
        return !isOnCaptchaPage && (!hasRecaptchaIframe || checkboxChecked);
      });
      
      if (captchaSolved) {
        break; // CAPTCHA is solved, exit loop
      }
      
      // Wait a bit before checking again
      if (i < 2) {
        await HumanEmulation.randomDelay(1000, 2000);
      }
    }
    
    return { solved: captchaSolved };
  }

  async handle2FAVerification(page, profile) {
    try {
      console.log('2FA (Two-Factor Authentication) challenge detected, attempting to handle...');
      console.log(`Profile ID: ${profile.adspowerId || 'unknown'}`);
      console.log(`Profile email: ${profile.email || 'unknown'}`);
      console.log(`Profile data check:`, {
        hasTotpSecret: !!profile.totpSecret,
        totpSecretType: typeof profile.totpSecret,
        totpSecretValue: profile.totpSecret ? `${profile.totpSecret.substring(0, 10)}...` : 'null/undefined',
        totpSecretLength: profile.totpSecret?.length || 0,
        hasTwoFactorCode: !!profile.twoFactorCode,
        allProfileKeys: Object.keys(profile)
      });
      
      // Reload profile from database to ensure we have latest data
      const freshProfile = await Profile.findById(profile.adspowerId);
      if (freshProfile) {
        console.log(`Fresh profile from DB:`, {
          hasTotpSecret: !!freshProfile.totpSecret,
          totpSecretLength: freshProfile.totpSecret?.length || 0,
          totpSecretPreview: freshProfile.totpSecret ? `${freshProfile.totpSecret.substring(0, 10)}...` : 'N/A'
        });
        // Use fresh profile data
        profile = freshProfile;
      }
      
      // Check if profile has 2FA credentials
      const totpSecret = profile.totpSecret;
      const twoFactorCode = profile.twoFactorCode;
      
      let code = null;
      
      if (totpSecret) {
        // Generate TOTP code from secret using functional API
        try {
          code = await generate({ secret: totpSecret });
          console.log(`✓ Generated TOTP code from secret (code: ${code})`);
        } catch (totpError) {
          console.error('✗ Failed to generate TOTP code:', totpError.message);
          throw new Error(`TOTP generation failed: ${totpError.message}`);
        }
      } else if (twoFactorCode) {
        // Use manual code provided
        code = String(twoFactorCode).replace(/\D/g, ''); // Remove non-digits
        if (code.length !== 6 && code.length !== 8) {
          console.error(`✗ Invalid 2FA code length: ${code.length} (expected 6 or 8 digits)`);
          throw new Error(`Invalid 2FA code format: must be 6 or 8 digits`);
        }
        console.log(`✓ Using manual 2FA code: ${code}`);
      } else {
        console.error('✗ No 2FA credentials found in profile');
        console.error('Profile must have either:');
        console.error('  - totpSecret: Base32 secret for TOTP generation');
        console.error('  - twoFactorCode: Manual 6-digit code');
        throw new Error('2FA credentials not found in profile');
      }
      
      // Wait a bit for page to load
      await HumanEmulation.randomDelay(2000, 3000);

      const authChoice = await page.evaluate(() => {
        const bodyText = (document.body.textContent || '').toLowerCase();
        const hasChoice = bodyText.includes('choose how you want to sign in') || bodyText.includes('2-step verification');
        const hasAuth = bodyText.includes('google authenticator') || bodyText.includes('authenticator app');
        const codeInputs = Array.from(document.querySelectorAll('input')).filter(input => {
          const type = (input.type || '').toLowerCase();
          const maxLength = input.maxLength;
          const label = (input.getAttribute('aria-label') || '').toLowerCase();
          const name = (input.name || '').toLowerCase();
          const id = (input.id || '').toLowerCase();
          const placeholder = (input.placeholder || '').toLowerCase();
          const isCode = (type === 'text' || type === 'tel' || type === 'number') &&
            (label.includes('code') || label.includes('verification') ||
             name.includes('code') || name.includes('verification') || name.includes('totp') ||
             id.includes('code') || id.includes('verification') || id.includes('totp') ||
             placeholder.includes('code') || placeholder.includes('verification')) &&
            (maxLength === 6 || maxLength === 8 || !maxLength);
          return isCode;
        });
        return { hasChoice, hasAuth, codeInputCount: codeInputs.length };
      });

      if ((authChoice.hasChoice || authChoice.hasAuth) && authChoice.codeInputCount === 0) {
        console.log('Looking for "Get a verification code from the Google Authenticator app" option...');
        const picked = await page.evaluate(() => {
          // Priority 1: Use specific data attributes from the HTML structure
          // Look for element with data-action="selectchallenge" and data-challengetype="6"
          const challengeElements = Array.from(document.querySelectorAll('[data-action="selectchallenge"]'));
          for (const el of challengeElements) {
            const challengeType = el.getAttribute('data-challengetype');
            const text = (el.textContent || '').toLowerCase();
            
            // Check if it's the authenticator option (type 6) or contains authenticator text
            if (challengeType === '6' || (text.includes('authenticator') && text.includes('verification code'))) {
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
              
              try {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                el.click();
                return { success: true, text: text.substring(0, 100), method: 'data-attribute' };
              } catch (e) {
                // Try parent if click fails
                const parent = el.parentElement;
                if (parent && (parent.tagName === 'LI' || parent.getAttribute('role') === 'link')) {
                  try {
                    parent.click();
                    return { success: true, text: text.substring(0, 100), method: 'parent-click' };
                  } catch (e2) {}
                }
              }
            }
          }
          
          // Priority 2: Look for elements with role="link" that contain authenticator text
          const linkElements = Array.from(document.querySelectorAll('[role="link"]'));
          for (const el of linkElements) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (text.includes('get') && text.includes('verification code') && 
                (text.includes('google authenticator') || text.includes('authenticator app'))) {
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
              
              try {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                el.click();
                return { success: true, text: text.substring(0, 100), method: 'role-link' };
              } catch (e) {}
            }
          }
          
          // Priority 3: Fallback - search by text content in any clickable element
          const allElements = Array.from(document.querySelectorAll('button, [role="button"], [role="link"], div[tabindex], li, a'));
          for (const el of allElements) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (!text) continue;
            
            const hasGet = text.includes('get');
            const hasVerificationCode = text.includes('verification code') || text.includes('verification');
            const hasAuthenticator = text.includes('google authenticator') || text.includes('authenticator app');
            
            if ((hasGet && hasVerificationCode && hasAuthenticator) || 
                (hasVerificationCode && hasAuthenticator)) {
              
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
              
              // Find clickable element (self or parent)
              let clickableEl = el;
              if (el.tagName === 'SPAN' || el.tagName === 'DIV') {
                let parent = el.parentElement;
                while (parent && parent !== document.body) {
                  if (parent.tagName === 'BUTTON' || 
                      parent.getAttribute('role') === 'button' ||
                      parent.getAttribute('role') === 'link' ||
                      parent.tagName === 'A' ||
                      parent.hasAttribute('tabindex')) {
                    clickableEl = parent;
                    break;
                  }
                  parent = parent.parentElement;
                }
              }
              
              try {
                clickableEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
                clickableEl.click();
                return { success: true, text: text.substring(0, 100), method: 'text-search' };
              } catch (e) {
                // Try dispatchEvent as fallback
                try {
                  const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
                  clickableEl.dispatchEvent(clickEvent);
                  return { success: true, text: text.substring(0, 100), method: 'dispatch-event' };
                } catch (e2) {}
              }
            }
          }
          
          return { success: false };
        });
        
        if (picked && picked.success) {
          console.log(`✓ Selected authenticator option: ${picked.text}`);
          await HumanEmulation.randomDelay(2000, 3000);
        } else {
          console.log('⚠ Could not find authenticator option, trying alternative verification...');
          await this.tryAlternativeVerification(page);
          await HumanEmulation.randomDelay(2000, 3000);
        }
      }
      
      // Find 2FA code input field
      const codeSelectors = [
        'input[type="text"][maxlength="6"]',
        'input[type="text"][maxlength="8"]',
        'input[type="tel"][maxlength="6"]',
        'input[type="tel"][maxlength="8"]',
        'input[name*="code"]',
        'input[id*="code"]',
        'input[id*="totp"]',
        'input[name*="totp"]',
        'input[aria-label*="code" i]',
        'input[aria-label*="verification" i]',
        'input[placeholder*="code" i]',
        'input[placeholder*="verification" i]'
      ];
      
      let codeInput = null;
      console.log('Searching for 2FA code input field...');
      
      for (const selector of codeSelectors) {
        try {
          codeInput = await page.waitForSelector(selector, { timeout: 3000 });
          if (codeInput) {
            console.log(`✓ Found 2FA code input using selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      // Try finding by evaluate if not found
      if (!codeInput) {
        console.log('2FA code input not found with selectors, trying evaluate method...');
        const foundCode = await page.evaluateHandle(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          return inputs.find(input => {
            const type = input.type.toLowerCase();
            const name = (input.name || '').toLowerCase();
            const id = (input.id || '').toLowerCase();
            const label = (input.getAttribute('aria-label') || '').toLowerCase();
            const placeholder = (input.placeholder || '').toLowerCase();
            const maxLength = input.maxLength;
            
            // Check if it's a code input (6 or 8 digits)
            const isCodeInput = (type === 'text' || type === 'tel' || type === 'number') &&
                               (name.includes('code') || name.includes('totp') || name.includes('verification') ||
                                id.includes('code') || id.includes('totp') || id.includes('verification') ||
                                label.includes('code') || label.includes('verification') ||
                                placeholder.includes('code') || placeholder.includes('verification')) &&
                               (maxLength === 6 || maxLength === 8 || !maxLength);
            
            if (isCodeInput) {
              const style = window.getComputedStyle(input);
              // Make sure it's visible
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                return input;
              }
            }
            return null;
          });
        });
        
        if (foundCode && foundCode.asElement()) {
          codeInput = foundCode.asElement();
          console.log('✓ Found 2FA code input using evaluate method');
        }
      }
      
      if (!codeInput) {
        console.error('✗ 2FA code input field not found');
        const allInputs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('input')).map(input => ({
            type: input.type,
            name: input.name,
            id: input.id,
            placeholder: input.placeholder,
            ariaLabel: input.getAttribute('aria-label'),
            maxLength: input.maxLength,
            visible: input.offsetParent !== null
          }));
        });
        console.log('All inputs found:', JSON.stringify(allInputs, null, 2));
        throw new Error('2FA code input field not found');
      }
      
      // Type the 2FA code
      try {
        await codeInput.focus();
        await HumanEmulation.randomDelay(200, 500);
        
        // Clear any existing text
        await codeInput.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await HumanEmulation.randomDelay(100, 200);
        
        // Type code with human-like delays
        console.log(`Typing 2FA code: ${code}...`);
        await codeInput.type(code, { delay: 100 + Math.random() * 100 });
        console.log('✓ 2FA code typed successfully');
        
        await HumanEmulation.randomDelay(500, 1000);
        
        // Add reading jitter to mimic human behavior
        await HumanEmulation.readingJitter(page, 2, 3);
        await HumanEmulation.randomDelay(1000, 2000);
        
      } catch (typeError) {
        if (typeError.message.includes('closed') || typeError.message.includes('detached')) {
          throw new Error('Page was closed during 2FA code input');
        }
        console.error('Error typing 2FA code:', typeError.message);
        throw typeError;
      }
      
      // Try to click Next/Verify button or press Enter
      await HumanEmulation.randomDelay(1000, 2000);
      
      const submitButton = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"], div[role="button"]'));
        const submitBtn = buttons.find(btn => {
          const text = (btn.textContent || btn.value || btn.innerText || '').toLowerCase();
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          return (/next|continue|verify|submit/i.test(text) || /next|continue|verify/i.test(ariaLabel)) &&
                 !/cancel|back|previous/i.test(text);
        });
        if (submitBtn) {
          submitBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return {
            id: submitBtn.id,
            text: submitBtn.textContent || submitBtn.value || submitBtn.innerText,
            tagName: submitBtn.tagName
          };
        }
        return null;
      });
      
      if (submitButton) {
        console.log(`Found submit button: ${submitButton.tagName} - "${submitButton.text}"`);
        try {
          if (submitButton.id) {
            await page.click(`#${submitButton.id}`, { delay: 100 + Math.random() * 100 });
          } else {
            await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"], div[role="button"]'));
              const submitBtn = buttons.find(btn => {
                const text = (btn.textContent || btn.value || btn.innerText || '').toLowerCase();
                const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                return (/next|continue|verify|submit/i.test(text) || /next|continue|verify/i.test(ariaLabel)) &&
                       !/cancel|back|previous/i.test(text);
              });
              if (submitBtn) submitBtn.click();
            });
          }
          console.log('✓ Clicked submit button after 2FA code');
        } catch (clickError) {
          console.log('Could not click button, pressing Enter...');
          await page.keyboard.press('Enter');
        }
      } else {
        console.log('Submit button not found, pressing Enter...');
        await page.keyboard.press('Enter');
      }
      
      // Wait for navigation after 2FA submission
      await HumanEmulation.randomDelay(2000, 3000);
      
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        console.log('✓ Navigation after 2FA code submission completed');
      } catch (navError) {
        console.log('Navigation timeout after 2FA code - may have already navigated');
      }
      
      // Verify we're no longer on 2FA page
      const isStillOn2FAPage = await page.evaluate(() => {
        const bodyText = document.body.textContent.toLowerCase();
        const url = window.location.href.toLowerCase();
        return /enter.*verification.*code|code.*from.*authenticator/i.test(bodyText) ||
               url.includes('/challenge/totp') || url.includes('/challenge/2fa');
      });
      
      // After 2FA, check for recovery settings page and home address page
      await HumanEmulation.randomDelay(2000, 3000);
      await this.handleRecoverySettingsPage(page, profile);
      await this.handleHomeAddressPage(page, profile);
      
      if (isStillOn2FAPage) {
        console.log('⚠ Still on 2FA page - code may have been incorrect or expired');
        throw new Error('2FA code verification failed - still on 2FA page');
      } else {
        console.log('✓ Successfully passed 2FA verification');
      }
      
      // Check again for another 2FA prompt (Google sometimes asks for code again on "Verify it's you" screen)
      await HumanEmulation.randomDelay(2000, 3000);
      const verifyItsYou = await page.evaluate(() => {
        const bodyText = document.body.textContent.toLowerCase();
        const url = window.location.href.toLowerCase();
        
        // Check for "Verify it's you" text
        const hasVerifyText = /verify.*it.*you|verify.*your.*identity/i.test(bodyText);
        
        // Check for "Get a verification code from the Google Authenticator app" text
        const hasAuthenticatorText = /get.*verification.*code.*from.*google.*authenticator|google.*authenticator.*app/i.test(bodyText);
        
        // Check for code input fields
        const codeInputs = Array.from(document.querySelectorAll('input')).filter(input => {
          const type = input.type.toLowerCase();
          const name = (input.name || '').toLowerCase();
          const id = (input.id || '').toLowerCase();
          const label = (input.getAttribute('aria-label') || '').toLowerCase();
          const placeholder = (input.placeholder || '').toLowerCase();
          const maxLength = input.maxLength;
          
          return (type === 'text' || type === 'tel' || type === 'number') &&
                 (name.includes('code') || name.includes('totp') || name.includes('verification') ||
                  id.includes('code') || id.includes('totp') || id.includes('verification') ||
                  label.includes('code') || label.includes('verification') ||
                  placeholder.includes('code') || placeholder.includes('verification')) &&
                 (maxLength === 6 || maxLength === 8 || !maxLength);
        });
        
        return {
          hasVerifyText,
          hasAuthenticatorText,
          codeInputCount: codeInputs.length,
          isVerifyScreen: hasVerifyText && (hasAuthenticatorText || codeInputs.length > 0)
        };
      });
      
      if (verifyItsYou.isVerifyScreen) {
        console.log('✓ Another "Verify it\'s you" screen detected - handling as 2FA');
        console.log(`  - Has verify text: ${verifyItsYou.hasVerifyText}`);
        console.log(`  - Has authenticator text: ${verifyItsYou.hasAuthenticatorText}`);
        console.log(`  - Code input fields found: ${verifyItsYou.codeInputCount}`);
        
        try {
          await this.handle2FAVerification(page, profile);
          await HumanEmulation.randomDelay(2000, 3000);
        } catch (verifyError) {
          console.log('Second 2FA verification failed:', verifyError.message);
          // Don't throw - continue with login flow
        }
      }
      
    } catch (error) {
      console.error('✗ 2FA verification error:', error.message);
      throw error;
    }
  }

  async handleSMSVerification(page) {
    try {
      console.log('SMS verification challenge detected, attempting to handle...');
      
      // First, verify that a phone input field actually exists and is visible
      const phoneInputInfo = await page.evaluate(() => {
        const phoneInputs = Array.from(document.querySelectorAll('input')).filter(input => {
          const type = input.type.toLowerCase();
          const name = (input.name || '').toLowerCase();
          const id = (input.id || '').toLowerCase();
          const label = (input.getAttribute('aria-label') || '').toLowerCase();
          const placeholder = (input.placeholder || '').toLowerCase();
          const isPhoneInput = type === 'tel' || 
                             name.includes('phone') || 
                             id.includes('phone') || 
                             label.includes('phone') ||
                             placeholder.includes('phone');
          
          if (!isPhoneInput) return false;
          
          // Check if input is visible and not disabled
          const rect = input.getBoundingClientRect();
          const style = window.getComputedStyle(input);
          const isVisible = rect.width > 0 && rect.height > 0 && 
                          style.display !== 'none' && 
                          style.visibility !== 'hidden' &&
                          !input.disabled &&
                          input.offsetParent !== null;
          
          return isVisible;
        });
        
        return {
          found: phoneInputs.length > 0,
          count: phoneInputs.length,
          selectors: phoneInputs.map(input => ({
            type: input.type,
            name: input.name,
            id: input.id,
            placeholder: input.placeholder
          }))
        };
      });
      
      if (!phoneInputInfo.found) {
        console.log('⚠ No visible phone input field found on page - skipping phone number rental');
        console.log('  - This may be a recovery settings page that doesn\'t require phone verification');
        console.log('  - Or the phone input field may not be visible yet');
        return;
      }
      
      console.log(`✓ Found ${phoneInputInfo.count} visible phone input field(s)`);
      
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
