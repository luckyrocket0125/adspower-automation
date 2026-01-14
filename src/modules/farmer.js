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
      page = (await browser.pages())[0] || await browser.newPage();

      const contentSuggestions = await getContentSuggestions(profile.persona);

      await this.browseRSSFeeds(page, profileId, contentSuggestions.rssFeeds);
      await this.useGoogleDrive(page, profileId);
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

  async browseRSSFeeds(page, profileId, rssFeeds) {
    const feedsToVisit = rssFeeds.slice(0, 3);

    for (const feedUrl of feedsToVisit) {
      try {
        const feed = await this.rssParser.parseURL(feedUrl);
        const articles = feed.items.slice(0, 2);

        for (const article of articles) {
          if (article.link) {
            try {
              // Check if page is still valid before navigation
              if (page.isClosed()) {
                console.log('Page closed, skipping RSS feed');
                break;
              }
              
              await page.goto(article.link, { waitUntil: 'networkidle2', timeout: 30000 });
              await HumanEmulation.randomDelay(2000, 4000);
              
              // Check again before reading simulation
              if (!page.isClosed()) {
                await HumanEmulation.simulateReading(page, 3000 + Math.random() * 5000);
                await HumanEmulation.readingJitter(page);
              }
            } catch (navError) {
              if (navError.message.includes('detached') || navError.message.includes('closed')) {
                console.log('Page detached/closed during RSS navigation, skipping');
                break;
              }
              throw navError;
            }

            try {
              const log = new InteractionLog({
                profileId,
                action: 'rss_browse',
                url: article.link,
                success: true
              });
              await log.save();
            } catch (logError) {
              console.error('Failed to save RSS log:', logError);
            }
          }
        }
      } catch (error) {
        console.error(`RSS feed error for ${feedUrl}:`, error);
      }
    }
  }

  async useGoogleDrive(page, profileId) {
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

      // Check before each operation
      if (page.isClosed()) {
        console.log('Page closed during Google Drive operation');
        return;
      }

      // Find the "New" or "Create" button
      const newButton = await page.$('button[aria-label*="New"], button[aria-label*="Create"]');
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
          await HumanEmulation.randomDelay(1000, 2000);
        } catch (clickError) {
          if (clickError.message.includes('detached') || clickError.message.includes('not clickable') || clickError.message.includes('not an Element')) {
            console.log('Button not clickable or detached, skipping Google Drive creation');
            return;
          }
          throw clickError;
        }

        // Check page state before looking for doc option
        if (page.isClosed()) {
          console.log('Page closed during Google Drive button click');
          return;
        }

        // Find Google Docs option using JavaScript evaluation (Puppeteer doesn't support text= selector)
        const docOption = await page.evaluateHandle(() => {
          const allElements = Array.from(document.querySelectorAll('div, span, button, a, li'));
          return allElements.find(el => {
            const text = (el.textContent || '').toLowerCase();
            return (text.includes('google docs') || text.includes('document')) && 
                   !text.includes('folder') && 
                   !text.includes('spreadsheet');
          });
        });
        
        if (docOption && docOption.asElement()) {
          try {
            const docElement = docOption.asElement();
            await docElement.scrollIntoView();
            await HumanEmulation.randomDelay(200, 500);
            await docElement.click();
            await HumanEmulation.randomDelay(3000, 5000);
          } catch (docClickError) {
            if (docClickError.message.includes('detached') || docClickError.message.includes('not clickable')) {
              console.log('Document option not clickable, skipping');
              return;
            }
            throw docClickError;
          }

          if (page.isClosed()) {
            console.log('Page closed during Google Docs creation');
            return;
          }

          const editor = await page.$('[contenteditable="true"], .kix-appview-editor');
          if (editor) {
            const sampleText = 'This is a test document created for profile management and automation testing purposes.';
            await HumanEmulation.humanType(page, '[contenteditable="true"], .kix-appview-editor', sampleText);
            await HumanEmulation.randomDelay(2000, 3000);
          }
        } else {
          console.log('Google Docs option not found');
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
      await HumanEmulation.randomDelay(2000, 4000);

      const searchBox = await page.$('input[placeholder*="Search"], input[id*="searchbox"]');
      if (searchBox) {
        try {
          // Use the element handle directly
          await searchBox.scrollIntoView();
          await HumanEmulation.randomDelay(200, 500);
          await searchBox.focus();
          await HumanEmulation.randomDelay(200, 500);
          await searchBox.type('Coffee', { delay: 50 + Math.random() * 50 });
          await HumanEmulation.randomDelay(1000, 2000);
        } catch (typeError) {
          if (typeError.message.includes('detached') || typeError.message.includes('not clickable')) {
            console.log('Search box not usable, skipping search');
            return;
          }
          throw typeError;
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
