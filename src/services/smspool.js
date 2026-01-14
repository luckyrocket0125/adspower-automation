import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const SMSPOOL_API_KEY = process.env.SMSPOOL_API_KEY;
const SMSPOOL_API_URL = 'https://smspool.net/api/v2';

export class SMSPoolService {
  constructor() {
    this.apiKey = SMSPOOL_API_KEY;
  }

  async rentNumber(service = 'google') {
    if (!this.apiKey) {
      throw new Error('SMSPOOL_API_KEY is not configured');
    }

    try {
      // Try multiple possible endpoints
      const endpoints = [
        `${SMSPOOL_API_URL}/order`,
        'https://smspool.net/api/order',
        'https://www.smspool.net/api/order',
        'https://smspool.net/api/v1/order'
      ];

      let lastError = null;
      for (const endpoint of endpoints) {
        try {
          const response = await axios.post(endpoint, {
            key: this.apiKey,
            service: service,
            country: 'US'
          }, {
            timeout: 10000,
            maxRedirects: 5, // Allow redirects (301/302 are common)
            validateStatus: (status) => status < 500 // Don't throw on 4xx
          });

          console.log(`SMSPool API response from ${endpoint}:`, {
            status: response.status,
            data: response.data
          });

          if (response.status === 200) {
            // Check different response formats
            if (response.data && (response.data.success || response.data.order_id || response.data.orderId)) {
              return {
                orderId: response.data.order_id || response.data.orderId || response.data.id,
                number: response.data.number || response.data.phone
              };
            }
            // Some APIs return data directly without success flag
            if (response.data && (response.data.order_id || response.data.number)) {
              return {
                orderId: response.data.order_id || response.data.id,
                number: response.data.number || response.data.phone
              };
            }
          }
          
          if (response.status === 404) {
            console.log(`Endpoint ${endpoint} returned 404, trying next...`);
            continue;
          }
          
          // Handle 301/302 redirects - axios should follow them automatically with maxRedirects > 0
          if (response.status === 301 || response.status === 302) {
            const location = response.headers?.location || response.headers?.Location;
            console.log(`Endpoint ${endpoint} returned ${response.status} redirect to: ${location || 'unknown'}`);
            // axios will follow redirects automatically, but if we get here, it might have failed
            // Try the redirected URL if we have it
            if (location && location.startsWith('http')) {
              try {
                const redirectResponse = await axios.post(location, {
                  key: this.apiKey,
                  service: service,
                  country: 'US'
                }, {
                  timeout: 10000,
                  maxRedirects: 5,
                  validateStatus: (status) => status < 500
                });
                
                if (redirectResponse.status === 200 && redirectResponse.data) {
                  if (redirectResponse.data.success || redirectResponse.data.order_id || redirectResponse.data.orderId) {
                    return {
                      orderId: redirectResponse.data.order_id || redirectResponse.data.orderId || redirectResponse.data.id,
                      number: redirectResponse.data.number || redirectResponse.data.phone
                    };
                  }
                }
              } catch (redirectError) {
                console.log('Redirect follow failed:', redirectError.message);
              }
            }
            continue; // Try next endpoint
          }
          
          // Log other non-200 responses
          if (response.status !== 200) {
            console.log(`Endpoint ${endpoint} returned status ${response.status}`);
            if (response.data && typeof response.data === 'object') {
              console.log('Response data:', JSON.stringify(response.data).substring(0, 200));
            }
          }
        } catch (error) {
          lastError = error;
          if (error.response && error.response.status === 404) {
            console.log(`Endpoint ${endpoint} not found, trying next...`);
            continue;
          }
          // If it's not a 404, break and throw
          throw error;
        }
      }

      // If all endpoints failed, return null instead of throwing
      // This allows the calling code to handle it gracefully
      console.error(`All SMSPool endpoints failed. Last error: ${lastError?.message || 'Unknown error'}.`);
      console.error('Please check SMSPool API documentation for correct endpoint or verify your API key.');
      return null;
    } catch (error) {
      console.error('SMSPool rent number error:', error.message);
      // Return null instead of throwing to allow graceful handling
      return null;
    }
  }

  async getSMS(orderId) {
    try {
      const response = await axios.get(`${SMSPOOL_API_URL}/check`, {
        params: {
          key: this.apiKey,
          order_id: orderId
        }
      });

      if (response.data.success && response.data.sms) {
        return response.data.sms;
      }
      return null;
    } catch (error) {
      console.error('SMSPool get SMS error:', error.message);
      throw error;
    }
  }

  async waitForSMS(orderId, maxWaitTime = 300000, checkInterval = 5000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      const sms = await this.getSMS(orderId);
      if (sms) {
        return sms;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    throw new Error('SMS timeout: No message received');
  }
}
