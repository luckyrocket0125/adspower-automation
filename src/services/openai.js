import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function analyzePersonaFromEmails(emailData) {
  try {
    const prompt = `Analyze these emails to predict User Gender, Age Bracket, and Top 3 Interests. 
    
Email Data:
${JSON.stringify(emailData, null, 2)}

Respond in JSON format:
{
  "gender": "Male/Female/Other",
  "ageBracket": "e.g., 25-35, 35-45, etc.",
  "interests": ["interest1", "interest2", "interest3"]
}`;

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

    const result = JSON.parse(completion.choices[0].message.content);
    return result;
  } catch (error) {
    console.error('OpenAI API error:', error.message);
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
