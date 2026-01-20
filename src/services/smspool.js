import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const SMSPOOL_API_KEY = process.env.SMSPOOL_API_KEY;
const SMSPOOL_API_URL = process.env.SMSPOOL_API_URL || 'https://api.smspool.net';

export class SMSPoolService {
  constructor() {
    this.apiKey = SMSPOOL_API_KEY;
    this.serviceCache = null;
    this.serviceCacheTime = null;
    this.serviceCacheTTL = 3600000; // 1 hour
  }

  async getServices() {
    if (this.serviceCache && this.serviceCacheTime && 
        (Date.now() - this.serviceCacheTime) < this.serviceCacheTTL) {
      return this.serviceCache;
    }

    try {
      const endpoints = [
        `${SMSPOOL_API_URL}/service/retrieve`,
        `${SMSPOOL_API_URL}/service/list`,
        `${SMSPOOL_API_URL}/services`,
        `${SMSPOOL_API_URL}/service/retrieve_all`
      ];

      for (const endpoint of endpoints) {
        try {
          const response = await axios.get(endpoint, {
            params: { key: this.apiKey },
            timeout: 10000,
            headers: { 'Accept': 'application/json' }
          });

          if (response.status === 200 && response.data) {
            if (response.data.success && response.data.data) {
              this.serviceCache = response.data.data;
              this.serviceCacheTime = Date.now();
              return this.serviceCache;
            }
            if (Array.isArray(response.data)) {
              this.serviceCache = response.data;
              this.serviceCacheTime = Date.now();
              return this.serviceCache;
            }
          }
        } catch (e) {
          continue;
        }
      }
      return null;
    } catch (error) {
      console.log('Could not retrieve services list:', error.message);
      return null;
    }
  }

  async findServiceId(serviceName = 'Google/Gmail') {
    // Known service IDs for common services
    const knownServiceIds = {
      'Google/Gmail': '395'
    };
    
    // Check known service IDs first
    const lowerName = serviceName.toLowerCase();
    if (knownServiceIds[lowerName] || knownServiceIds[serviceName]) {
      const knownId = knownServiceIds[lowerName] || knownServiceIds[serviceName];
      console.log(`Using known service ID for "${serviceName}": ${knownId}`);
      return knownId;
    }
    
    // Try to retrieve from API
    const services = await this.getServices();
    if (!services || !Array.isArray(services)) {
      return null;
    }

    const searchName = serviceName.toLowerCase();
    for (const service of services) {
      const name = (service.name || service.service_name || '').toLowerCase();
      const id = service.id || service.service_id || service.serviceId;
      
      if (name.includes(searchName) || searchName.includes(name)) {
        return id || service.service_id || service.serviceId;
      }
    }
    return null;
  }

  parseRentResponse(responseData) {
    if (!responseData) return null;
    
    // Helper to ensure values are strings
    const toString = (val) => val != null ? String(val) : null;
    
    // Format 1: Nested data structure (response.data.data)
    if (responseData.data) {
      const data = responseData.data;
      if (data.order_id || data.orderId || data.id || data.number || data.phone) {
        return {
          orderId: toString(data.order_id || data.orderId || data.id || responseData.order_id || responseData.orderId),
          number: toString(data.number || data.phone || responseData.number || responseData.phone)
        };
      }
    }
    
    // Format 2: Direct structure (response.data.order_id)
    if (responseData.order_id || responseData.orderId || responseData.number || responseData.phone) {
      return {
        orderId: toString(responseData.order_id || responseData.orderId || responseData.id),
        number: toString(responseData.number || responseData.phone)
      };
    }
    
    // Format 3: Check nested structures recursively
    const checkNested = (obj, depth = 0) => {
      if (depth > 4 || !obj || typeof obj !== 'object') return null;
      
      if (obj.order_id || obj.orderId || obj.id) {
        return {
          orderId: toString(obj.order_id || obj.orderId || obj.id),
          number: toString(obj.number || obj.phone || obj.phone_number)
        };
      }
      
      for (const key in obj) {
        if (key.toLowerCase().includes('order') || 
            key.toLowerCase().includes('phone') || 
            key.toLowerCase().includes('number') ||
            key.toLowerCase().includes('rental')) {
          const result = checkNested(obj[key], depth + 1);
          if (result) return result;
        }
      }
      return null;
    };
    
    const result = checkNested(responseData);
    if (result) {
      return {
        orderId: toString(result.orderId),
        number: toString(result.number)
      };
    }
    return null;
  }

  async getActiveOrders(service = 'Google/Gmail') {
    if (!this.apiKey) {
      return [];
    }

    try {
      const endpoints = [
        `${SMSPOOL_API_URL}/request/active`
      ];

      for (const endpoint of endpoints) {
        try {
          const response = await axios.get(endpoint, {
            params: { key: this.apiKey },
            timeout: 10000,
            headers: { 'Accept': 'application/json' }
          });

          if (response.status === 200 && response.data) {
            // Parse response - could be array or object with data array
            let orders = [];
            if (Array.isArray(response.data)) {
              orders = response.data;
            } else if (response.data.data && Array.isArray(response.data.data)) {
              orders = response.data.data;
            } else if (response.data.orders && Array.isArray(response.data.orders)) {
              orders = response.data.orders;
            } else if (response.data.active && Array.isArray(response.data.active)) {
              orders = response.data.active;
            }

            // Filter for the specific service (Google/Gmail = service ID 395)
            const serviceId = '395';
            const filteredOrders = orders.filter(order => {
              const orderService = order.service_id || order.service || order.serviceId;
              return orderService == serviceId || 
                     orderService === '395' || 
                     String(orderService).toLowerCase().includes('google') ||
                     String(orderService).toLowerCase().includes('gmail');
            });

            if (filteredOrders.length > 0) {
              console.log(`Found ${filteredOrders.length} active order(s) for Google/Gmail`);
              return filteredOrders;
            }
          }
        } catch (e) {
          continue;
        }
      }
      return [];
    } catch (error) {
      console.log('Error checking active orders:', error.message);
      return [];
    }
  }

  async rentNumber(service = 'Google/Gmail', country = 'US') {
    if (!this.apiKey) {
      throw new Error('SMSPOOL_API_KEY is not configured');
    }

    try {
      // Step 1: Check for active/usable phone numbers first
      console.log('Checking for active phone numbers...');
      const activeOrders = await this.getActiveOrders(service);
       console.log('Active orders:', activeOrders);
        if (activeOrders && activeOrders.length > 0) {
          const usableOrders = activeOrders.filter(order => {
            // Skip completed orders with no time left (already used for one-time verification)
            if (order.status === 'completed' && (!order.time_left || order.time_left === 0)) {
              return false;
            }
            
            // Use all other orders (not completed, or completed but still have time left)
            return true;
          });
          
          console.log(`Filtered ${activeOrders.length} active orders to ${usableOrders.length} usable orders for one-time verification`);
          
          // If we have usable orders, use the first one
          if (usableOrders.length > 0) {
            const activeOrder = usableOrders[0];
            // Based on actual API response structure:
            // order_code, number, phonenumber, code, status, time_left
            const orderId = activeOrder.order_code;
            const number = activeOrder.number || activeOrder.phonenumber;
            
            console.log(`Extracted - orderId: ${orderId}, number: ${number}, status: ${activeOrder.status}`);
            
            if (orderId && number) {
              console.log(`✓ Found active phone number: ${number} (Order Code: ${orderId})`);
              return {
                orderId: String(orderId),
                number: String(number),
                isActive: true
              };
            } else {
              console.log('⚠ Active order found but missing order_code or number field');
              console.log('Available fields:', Object.keys(activeOrder));
              // Continue to purchase new number
            }
          } else {
            console.log('No usable active orders found (all are completed with no time left)');
            // Continue to purchase new number
          }
        }
      
      // No usable active orders found, purchase new number
      console.log('No active phone numbers found, purchasing new number...');
      const baseUrls = [
        SMSPOOL_API_URL
      ];
      
      const endpointConfigs = [];
      for (const baseUrl of baseUrls) {
        endpointConfigs.push(
          { url: `${baseUrl}/purchase/sms`, method: 'POST', body: true } // Fallback
        );
      }

      let lastError = null;
      let lastSuccessfulResponse = null;
      
      for (const config of endpointConfigs) {
        try {
          let response;
          // First, get the service ID - for Google/Gmail, we know it's 395
          let serviceId = null;
          try {
            // serviceId = await this.findServiceId(service);
            serviceId = '395';
            if (serviceId) {
              console.log(`Found service ID for "${service}": ${serviceId}`);
            }
          } catch (e) {
            console.log('Could not retrieve service ID, will try service name');
          }

          const requestDataFormats = [];
          
          if (serviceId) {
            requestDataFormats.push(
              { key: this.apiKey, service: parseInt(serviceId), country: country }, // Service ID as number
              { key: this.apiKey, service: serviceId, country: country }, // Service ID as string
              { key: this.apiKey, service: Number(serviceId), country: country } // Explicit number conversion
            );
          }
          
          // Format 2: With service name 'Google/Gmail'
          requestDataFormats.push(
            { key: this.apiKey, service: 'Google/Gmail', country: country },
            { key: this.apiKey, service: service, country: country }
          );
          
          // Format 3: With 'api_key' instead of 'key' (some API versions use this)
          if (serviceId) {
            requestDataFormats.push(
              { api_key: this.apiKey, service: parseInt(serviceId), country: country },
              { api_key: this.apiKey, service: serviceId, country: country }
            );
          }
          requestDataFormats.push({ api_key: this.apiKey, service: 'Google/Gmail', country: country });
          
          // Format 4: Without country (country may be optional)
          if (serviceId) {
            requestDataFormats.push(
              { key: this.apiKey, service: parseInt(serviceId) },
              { key: this.apiKey, service: serviceId }
            );
          }
          requestDataFormats.push({ key: this.apiKey, service: 'Google/Gmail' });
          
          const requestConfig = {
            timeout: 15000,
            maxRedirects: 5,
            validateStatus: (status) => status < 500,
            headers: {
              'Accept': 'application/json'
            }
          };
          
          // Try each parameter format
          for (let formatIndex = 0; formatIndex < requestDataFormats.length; formatIndex++) {
            const requestData = requestDataFormats[formatIndex];
            
            try {
              if (config.method === 'POST') {
                // Try URL-encoded form data first (most common for SMSPool)
                const params = new URLSearchParams();
                Object.keys(requestData).forEach(key => {
                  const value = requestData[key];
                  if (value !== null && value !== undefined) {
                    params.append(key, String(value));
                  }
                });
                
                const paramsObj = Object.fromEntries(params);
                console.log(`Attempting request ${formatIndex + 1}/${requestDataFormats.length}:`, {
                  url: config.url,
                  method: 'POST',
                  params: paramsObj,
                  hasService: !!paramsObj.service,
                  serviceValue: paramsObj.service
                });
                
                try {
                  response = await axios.post(config.url, params.toString(), {
                    ...requestConfig,
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded',
                      'Accept': 'application/json'
                    }
                  });
                } catch (formError) {
                  // If form data fails, try JSON
                  requestConfig.headers['Content-Type'] = 'application/json';
                  if (config.body) {
                    response = await axios.post(config.url, requestData, requestConfig);
                  } else {
                    response = await axios.post(config.url, null, {
                      ...requestConfig,
                      params: requestData
                    });
                  }
                }
              } else {
                response = await axios.get(config.url, {
                  ...requestConfig,
                  params: requestData
                });
              }
              
              // Check if we got a successful response
              // Note: Some APIs return 200 even with errors, so we need to check the response data
              if (response.status === 200) {
                // Check if response actually contains success data
                const hasSuccessData = response.data && (
                  response.data.success === true ||
                  response.data.success === 1 ||
                  response.data.order_id ||
                  response.data.orderId ||
                  response.data.number ||
                  response.data.phone ||
                  (response.data.data && (response.data.data.order_id || response.data.data.number))
                );
                
                if (hasSuccessData) {
                  lastSuccessfulResponse = response;
                  break; // Success, exit format loop
                } else if (response.data && response.data.success === false) {
                  // API returned 200 but with success: false - this is an error
                  console.log(`Endpoint ${config.url} returned 200 but success: false`);
                  if (response.data.message || response.data.error) {
                    console.log(`Error message: ${response.data.message || response.data.error}`);
                  }
                  continue; // Try next format
                }
                // If 200 but unclear structure, save it and continue to check if we can parse it later
                if (!lastSuccessfulResponse) {
                  lastSuccessfulResponse = response;
                }
              }
              
              // If 400, log the error details
              if (response.status === 400 && response.data) {
                console.log(`Endpoint ${config.url} returned 400 (Bad Request)`);
                if (response.data.errors && Array.isArray(response.data.errors)) {
                  response.data.errors.forEach(err => {
                    console.log(`  - ${err.param || 'unknown'}: ${err.message || err.description || 'Unknown error'}`);
                  });
                } else if (response.data.message) {
                  console.log(`  Error: ${response.data.message}`);
                }
                // Continue to try next format
                continue;
              }
              
              // If 403, this endpoint exists but might need different auth
              if (response.status === 403) {
                console.log(`Endpoint ${config.url} returned 403 (Forbidden) - endpoint exists but access denied`);
                console.log('This might mean:');
                console.log('  - API key is invalid or expired');
                console.log('  - API key lacks required permissions');
                console.log('  - Account balance is insufficient');
                console.log('  - Different authentication method required');
                // Continue to try other formats/endpoints
              }
              
              // If 404, try next format
              if (response.status === 404) {
                continue; // Try next format
              }
              
            } catch (formatError) {
              if (formatError.response && formatError.response.status === 404) {
                continue; // Try next format
              }
              // For other errors, log and continue
              lastError = formatError;
            }
          }
          
          // If we got a successful response, break out of endpoint loop
          if (lastSuccessfulResponse && lastSuccessfulResponse.status === 200) {
            break;
          }
          
          // Try with API key in headers as fallback
          if (!lastSuccessfulResponse || lastSuccessfulResponse.status !== 200) {
            const headerConfig = {
              ...requestConfig,
              headers: {
                ...requestConfig.headers,
                'X-API-Key': this.apiKey,
                'Authorization': `Bearer ${this.apiKey}`,
                'api-key': this.apiKey,
                'API-Key': this.apiKey
              }
            };
            
            try {
              if (config.method === 'POST') {
                headerConfig.headers['Content-Type'] = 'application/json';
                response = await axios.post(config.url, {
                  service: service,
                  country: 'US'
                }, headerConfig);
              } else {
                response = await axios.get(config.url, {
                  ...headerConfig,
                  params: {
                    service: service,
                    country: 'US'
                  }
                });
              }
              
              if (response.status === 200) {
                lastSuccessfulResponse = response;
                break; // Success
              }
            } catch (headerError) {
              // Continue trying
            }
          }

          console.log(`SMSPool API response from ${config.url} (${config.method}):`, {
            status: response.status,
            data: typeof response.data === 'string' ? response.data.substring(0, 200) : response.data
          });

          if (response.status === 200) {
            // Log full response for debugging
            console.log('Full response data:', JSON.stringify(response.data, null, 2));
            
            // Use the helper method to parse response
            const parsed = this.parseRentResponse(response.data);
            if (parsed && (parsed.orderId || parsed.number)) {
              console.log('✓ Successfully parsed response:', parsed);
              return parsed;
            }
            
            console.log('⚠ Response status 200 but could not parse phone number/order ID from response');
            console.log('Response structure:', JSON.stringify(response.data, null, 2));
            console.log('Please check the response format and update the parser if needed.');
          }
          
          if (response.status === 404) {
            console.log(`Endpoint ${config.url} (${config.method}) returned 404, trying next...`);
            continue;
          }
          
          // Handle 301/302 redirects - axios should follow them automatically with maxRedirects > 0
          if (response.status === 301 || response.status === 302) {
            const location = response.headers?.location || response.headers?.Location;
            console.log(`Endpoint ${config.url} returned ${response.status} redirect to: ${location || 'unknown'}`);
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
            console.log(`Endpoint ${config.url} returned status ${response.status}`);
            if (response.data && typeof response.data === 'object') {
              console.log('Response data:', JSON.stringify(response.data).substring(0, 200));
            }
          }
        } catch (error) {
          lastError = error;
          if (error.response && error.response.status === 404) {
            console.log(`Endpoint ${config.url} (${config.method}) not found, trying next...`);
            continue;
          }
          // If it's not a 404, log but continue trying other endpoints
          if (error.response) {
            console.log(`Endpoint ${config.url} (${config.method}) error: ${error.response.status} - ${error.response.statusText}`);
          } else {
            console.log(`Endpoint ${config.url} (${config.method}) error: ${error.message}`);
          }
          continue;
        }
      }

      // Before giving up, try to parse lastSuccessfulResponse if we have one
      if (lastSuccessfulResponse && lastSuccessfulResponse.status === 200) {
        console.log('Attempting to parse last successful response...');
        const parsed = this.parseRentResponse(lastSuccessfulResponse.data);
        if (parsed && (parsed.orderId || parsed.number)) {
          console.log('✓ Successfully parsed response:', parsed);
          return parsed;
        }
      }

      console.error(`All SMSPool endpoints failed. Last error: ${lastError?.message || 'Unknown error'}.`);
      return null;
    } catch (error) {
      console.error('SMSPool rent number error:', error.message);
      // Return null instead of throwing to allow graceful handling
      return null;
    }
  }

  async getSMS(orderIdOrPhoneNumber) {
    try {
      // Recommended approach: Use /request/active to get all active orders and find SMS
      console.log(`Checking for SMS code using identifier: ${orderIdOrPhoneNumber}`);
      
      // First, try to get active orders and find the matching one
      const activeOrders = await this.getActiveOrders('Google/Gmail');
      
      if (activeOrders && activeOrders.length > 0) {
        console.log(`Searching ${activeOrders.length} active order(s) for identifier: ${orderIdOrPhoneNumber}`);
        
        // Find the order matching our identifier
        const matchingOrder = activeOrders.find(order => {
          // Use order_code (actual field name from API)
          const orderId = order.order_code ? String(order.order_code) : '';
          // Check both number and phonenumber fields (API provides both)
          const number = order.number ? String(order.number) : '';
          const phonenumber = order.phonenumber ? String(order.phonenumber) : '';
          const identifier = String(orderIdOrPhoneNumber || '');
          
          // Match by order_code
          if (orderId && orderId === identifier) {
            console.log(`✓ Matched by order_code: ${orderId}`);
            return true;
          }
          
          // Match by phone number (check both number and phonenumber fields)
          if (number || phonenumber) {
            const numberDigits = number.replace(/[^\d]/g, '');
            const phonenumberDigits = phonenumber.replace(/[^\d]/g, '');
            const identifierDigits = identifier.replace(/[^\d]/g, '');
            
            const matchesNumber = numberDigits && numberDigits === identifierDigits;
            const matchesPhonenumber = phonenumberDigits && phonenumberDigits === identifierDigits;
            
            if (matchesNumber || matchesPhonenumber) {
              console.log(`✓ Matched by phone number: ${number || phonenumber} (identifier: ${identifier})`);
              return true;
            }
          }
          
          return false;
        });
        
        if (matchingOrder) {
          // Check if this order has SMS code - API provides 'code' or 'full_code'
          const sms = matchingOrder.code || matchingOrder.full_code || matchingOrder.sms || matchingOrder.message;
          if (sms) {
            // Extract code from full_code if it's a message like "G-197219 is your Google verification code..."
            const codeMatch = String(sms).match(/\b\d{4,8}\b/);
            if (codeMatch) {
              console.log(`✓ Found SMS code in active order: ${codeMatch[0]}`);
              return codeMatch[0];
            }
            return String(sms);
          }
        }
      }
      
      // Fallback: Try traditional check endpoints
      const paramFormats = [
        { key: this.apiKey, order_id: orderIdOrPhoneNumber },
        { key: this.apiKey, phone: orderIdOrPhoneNumber },
        { key: this.apiKey, number: orderIdOrPhoneNumber },
        { key: this.apiKey, rental_id: orderIdOrPhoneNumber },
        { key: this.apiKey, id: orderIdOrPhoneNumber }
      ];
      
      const endpoints = [
        `${SMSPOOL_API_URL}/request/active`
      ];
      
      for (const endpoint of endpoints) {
        for (const params of paramFormats) {
          try {
            const response = await axios.get(endpoint, {
              params: params,
              timeout: 10000,
              headers: {
                'Accept': 'application/json'
              }
            });

            if (response.status === 200 && response.data) {
              // If endpoint is /request/active, parse the orders array
              if (endpoint.includes('/active')) {
                let orders = [];
                if (Array.isArray(response.data)) {
                  orders = response.data;
                } else if (response.data.data && Array.isArray(response.data.data)) {
                  orders = response.data.data;
                }
                
                // Find matching order and extract SMS
                for (const order of orders) {
                  // Use order_code (actual field name from API response)
                  const orderId = String(order.order_code || order.order_id || order.id || '');
                  const number = String(order.number || order.phonenumber || order.phone || '');
                  const identifier = String(orderIdOrPhoneNumber || '');
                  
                  if (orderId === identifier || 
                      number.replace(/[^\d]/g, '') === identifier.replace(/[^\d]/g, '')) {
                    // API provides 'code' or 'full_code' fields
                    const sms = order.code || order.full_code || order.sms || order.message;
                    if (sms) {
                      // Extract code from full_code if it's a message
                      const codeMatch = String(sms).match(/\b\d{4,8}\b/);
                      if (codeMatch) {
                        return codeMatch[0];
                      }
                      return String(sms);
                    }
                  }
                }
              } else {
                // Traditional SMS check endpoints
                if (response.data.success && response.data.sms) {
                  return response.data.sms;
                }
                if (response.data.sms) {
                  return response.data.sms;
                }
                if (response.data.code) {
                  return response.data.code;
                }
                if (response.data.message) {
                  const codeMatch = response.data.message.match(/\b\d{4,8}\b/);
                  if (codeMatch) {
                    return codeMatch[0];
                  }
                  return response.data.message;
                }
                if (typeof response.data === 'string' && /^\d{4,8}$/.test(response.data.trim())) {
                  return response.data.trim();
                }
              }
            }
          } catch (paramError) {
            if (paramError.response && paramError.response.status === 404) {
              continue; // Try next param format
            }
            continue;
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error('SMSPool get SMS error:', error.message);
      throw error;
    }
  }

  async waitForSMS(orderIdOrPhoneNumber, maxWaitTime = 300000, checkInterval = 5000) {
    const startTime = Date.now();
    let attemptCount = 0;
    const maxAttempts = Math.floor(maxWaitTime / checkInterval);
    
    console.log(`Waiting for SMS code (max wait: ${maxWaitTime / 1000}s, checking every ${checkInterval / 1000}s)...`);
    
    while (Date.now() - startTime < maxWaitTime) {
      attemptCount++;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      
      if (attemptCount % 6 === 0) {
        console.log(`Still waiting for SMS... (${elapsed}s elapsed, attempt ${attemptCount}/${maxAttempts})`);
      }
      
      try {
        const sms = await this.getSMS(orderIdOrPhoneNumber);
        if (sms) {
          const code = sms.toString().trim();
          if (code.length >= 4 && code.length <= 8 && /^\d+$/.test(code)) {
            console.log(`✓ SMS code received after ${elapsed}s: ${code}`);
            return code;
          } else {
            const codeMatch = code.match(/\b\d{4,8}\b/);
            if (codeMatch) {
              console.log(`✓ SMS code extracted after ${elapsed}s: ${codeMatch[0]}`);
              return codeMatch[0];
            }
          }
        }
      } catch (error) {
        if (attemptCount % 6 === 0) {
          console.log(`Error checking for SMS (attempt ${attemptCount}): ${error.message}`);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    throw new Error(`SMS timeout: No message received within ${maxWaitTime / 1000} seconds`);
  }
}
