import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function analyzePersonaFromEmails(emailData) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured in .env file');
    }
    
    if (!emailData || !Array.isArray(emailData) || emailData.length === 0) {
      throw new Error('No email data provided for analysis');
    }
    
    console.log(`Analyzing ${emailData.length} data item(s) with OpenAI (gpt-4o-mini)...`);
    
    // Check if this is account settings data or email data
    const isAccountSettings = emailData[0]?.type === 'account_settings';
    
    let prompt;
    if (isAccountSettings) {
      prompt = `Analyze this Google account settings data to predict User Gender, Age Bracket, and Top 3 Interests.

Account Settings Data:
${JSON.stringify(emailData, null, 2)}

Use the following information:
- Birthday/Date of Birth: Calculate age bracket from birthday if available
- Gender: Use if explicitly provided
- Name: Can indicate gender if name is gender-specific
- Location: Can indicate interests based on region
- Language: Can indicate cultural background
- Email domain: Can indicate interests (e.g., .edu for education, company domains for work interests)
- Recovery email: Additional context

If birthday is provided, calculate the age bracket (e.g., if birthday suggests age 30, use "25-35" or "30-40").
If gender is not provided, infer from name if possible, otherwise use "Other".

Respond in JSON format:
{
  "gender": "Male/Female/Other",
  "ageBracket": "e.g., 25-35, 35-45, etc.",
  "interests": ["interest1", "interest2", "interest3"]
}`;
    } else {
      prompt = `Analyze these emails to predict User Gender, Age Bracket, and Top 3 Interests. 
    
Email Data:
${JSON.stringify(emailData, null, 2)}

Respond in JSON format:
{
  "gender": "Male/Female/Other",
  "ageBracket": "e.g., 25-35, 35-45, etc.",
  "interests": ["interest1", "interest2", "interest3"]
}`;
    }

    console.log('Sending request to OpenAI API...');
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert at analyzing user behavior and interests from email data. Return only valid JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: { type: 'json_object' }
    });

    console.log('OpenAI API response received');
    const result = JSON.parse(completion.choices[0].message.content);
    console.log('Parsed persona result:', result);
    
    // Validate result structure
    if (!result.gender || !result.ageBracket) {
      console.error('Invalid OpenAI response structure:', result);
      throw new Error('OpenAI returned invalid persona data structure');
    }
    
    return result;
  } catch (error) {
    console.error('OpenAI API error:', error.message);
    if (error.response) {
      console.error('OpenAI API response error:', error.response.data);
    }
    throw error;
  }
}

export async function getContentSuggestions(profileData) {
  try {
    const { ageBracket, gender, interests } = profileData;
    
    const prompt = `Based on this user profile:
- Age: ${ageBracket}
- Gender: ${gender}
- Interests: ${interests.join(', ')}

Provide:
1. 5 RSS feed URLs that match their interests
2. 5 Google search queries they would likely perform
3. Topics they would be interested in

Respond in JSON format:
{
  "rssFeeds": ["url1", "url2", ...],
  "searchQueries": ["query1", "query2", ...],
  "topics": ["topic1", "topic2", ...]
}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert at recommending personalized content based on user demographics and interests. Return only valid JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(completion.choices[0].message.content);
    return result;
  } catch (error) {
    console.error('OpenAI API error:', error.message);
    throw error;
  }
}
