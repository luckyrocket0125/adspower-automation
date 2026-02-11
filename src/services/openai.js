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
    
    // Check if account settings data (with birthday) is included
    const hasAccountSettings = emailData.some(item => item.type === 'account_settings' || item.birthday);
    const accountSettingsItem = emailData.find(item => item.type === 'account_settings' || item.birthday);
    
    let prompt;
    if (isAccountSettings || hasAccountSettings) {
      prompt = `Analyze this Google account settings data to predict User Gender, Age Bracket, and Top 3 Interests.

Account Settings Data:
${JSON.stringify(emailData, null, 2)}

CRITICAL INSTRUCTIONS:
1. **Age Calculation**: 
   - If calculatedAge and ageBracket are provided, USE THOSE EXACT VALUES - do not recalculate
   - If birthday/date of birth is provided but no calculatedAge, calculate the EXACT age and use appropriate age bracket:
     - 18-25 (young adults)
     - 25-35 (young professionals)
     - 35-45 (mid-career)
     - 45-55 (established professionals)
     - 55-65 (senior professionals)
     - 65+ (retirees)
   - DO NOT default to 25-35. Use diverse age brackets based on actual birthday or calculated age.

2. **Gender Diversity**: 
   - Use gender from settings if explicitly provided
   - If not provided, infer from name if name is clearly gender-specific
   - If uncertain, use "Other" or make a reasonable inference
   - DO NOT default to "Male". Ensure gender diversity (Male, Female, Other).

3. **Interests MUST be general and personalized**:
   - Interests should reflect real-world hobbies, activities, and topics
   - Examples: "Technology", "Travel", "Cooking", "Fitness", "Music", "Reading", "Photography", "Gaming", "Sports", "Art", "Fashion", "Business", "Education"
   - DO NOT use Google services as interests (e.g., "Gmail", "YouTube", "Google Drive", "Google Security", "Google Account", "Google Privacy", "Google Settings", "2-Step Verification", "Security Checkup")
   - EXCLUDE all Google general services, security notifications, account settings, privacy updates, and system notifications from interest analysis
   - Focus on real-world interests from actual email content, senders, and topics
   - Interests should be appropriate for the user's age, gender, and email content
   - Base interests on email content, location, language, and demographic data

Use the following information:
- Birthday/Date of Birth: Calculate EXACT age and appropriate age bracket
- Gender: Use if explicitly provided, otherwise infer from name or use "Other"
- Name: Can indicate gender if name is gender-specific
- Location: Can indicate interests based on region (e.g., coastal areas suggest travel/outdoor activities)
- Language: Can indicate cultural background and interests
- Email domain: Can indicate interests (e.g., .edu for education, company domains for work interests)
- Email content: Analyze topics, senders, and patterns to infer interests
- Recovery email: Additional context

Respond in JSON format:
{
  "gender": "Male/Female/Other",
  "ageBracket": "e.g., 18-25, 25-35, 35-45, 45-55, 55-65, 65+",
  "interests": ["general interest 1", "general interest 2", "general interest 3"]
}`;
    } else {
      prompt = `Analyze these emails to predict User Gender, Age Bracket, and Top 3 Interests. 
    
Email Data:
${JSON.stringify(emailData, null, 2)}

CRITICAL INSTRUCTIONS:
1. **Age Diversity**: 
   - Analyze email content, senders, topics, and writing style to infer age
   - Use diverse age brackets: 18-25, 25-35, 35-45, 45-55, 55-65, 65+
   - DO NOT default to 25-35. Consider email patterns, language, and content to determine appropriate age

2. **Gender Diversity**:
   - Infer gender from email content, name, writing style, and topics
   - Use "Male", "Female", or "Other" based on evidence
   - DO NOT default to "Male". Ensure gender diversity.

3. **Interests MUST be general and personalized**:
   - Interests should reflect real-world hobbies, activities, and topics based on email content
   - Examples: "Technology", "Travel", "Cooking", "Fitness", "Music", "Reading", "Photography", "Gaming", "Sports", "Art", "Fashion", "Business", "Education", "Health", "Finance"
   - DO NOT use Google services as interests (e.g., "Gmail", "YouTube", "Google Drive", "Google Security", "Google Account", "Google Privacy", "Google Settings", "2-Step Verification", "Security Checkup")
   - EXCLUDE all Google general services, security notifications, account settings, privacy updates, and system notifications from interest analysis
   - Focus on real-world interests from actual email content, senders, and topics
   - Analyze email senders, subjects, and content to infer genuine interests (ignore Google system emails)
   - Interests should be appropriate for the inferred age and gender

Respond in JSON format:
{
  "gender": "Male/Female/Other",
  "ageBracket": "e.g., 18-25, 25-35, 35-45, 45-55, 55-65, 65+",
  "interests": ["general interest 1", "general interest 2", "general interest 3"]
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

export async function generateYouTubeComment(videoTitle, videoDescription, profilePersona) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured in .env file');
    }

    const ageBracket = profilePersona?.ageBracket || '25-35';
    const gender = profilePersona?.gender || 'Other';
    const interests = profilePersona?.interests || [];

    const prompt = `Generate a natural, authentic YouTube comment for this video. The comment should:
1. Be relevant to the video content
2. Sound like a real person wrote it (not a bot)
3. Be appropriate for someone who is ${ageBracket} years old, ${gender}
4. Be brief (1-2 sentences, max 200 characters)
5. Show genuine engagement with the video
6. Avoid generic phrases like "great video", "thanks", "nice"
7. Reference something specific from the video if possible

Video Title: ${videoTitle || 'Not available'}
Video Description: ${videoDescription ? videoDescription.substring(0, 500) : 'Not available'}
User Profile: ${ageBracket}, ${gender}, Interests: ${interests.join(', ') || 'General'}

Respond in JSON format:
{
  "comment": "the natural comment text here"
}`;

    console.log('Generating YouTube comment with OpenAI...');
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert at writing natural, authentic social media comments that sound like real people wrote them. Return only valid JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.8
    });

    const result = JSON.parse(completion.choices[0].message.content);
    if (!result.comment || typeof result.comment !== 'string') {
      throw new Error('OpenAI returned invalid comment structure');
    }

    console.log('Generated YouTube comment:', result.comment);
    return result.comment.trim();
  } catch (error) {
    console.error('OpenAI API error generating comment:', error.message);
    throw error;
  }
}
