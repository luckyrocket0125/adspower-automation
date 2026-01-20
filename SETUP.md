# Setup Guide

## Prerequisites

1. **Node.js** (v18 or higher)
2. **MongoDB** (running locally or remote connection string)
3. **AdsPower** installed and running locally (default API: http://localhost:50325)
4. **API Keys**:
   - OpenAI API key (for gpt-4o-mini)
   - SMSPool API key (for SMS verification)
   - CapMonster API key (for CAPTCHA solving)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file from `.env.example`:
```bash
cp .env.example .env
```

3. Edit `.env` and add your API keys:
```
MONGODB_URI=mongodb://localhost:27017/adspower_automation
OPENAI_API_KEY=sk-your-openai-key-here
ADSPOWER_API_URL=http://localhost:50325
SMSPOOL_API_KEY=your-smspool-key-here
CAPMONSTER_API_KEY=your-capmonster-key-here
PORT=3000
```

4. Start MongoDB (if running locally):
```bash
mongod
```

5. Start the application:
```bash
npm start
```

6. Open the dashboard:
```
http://localhost:3000
```

## Usage

### Creating a Profile

1. Go to the dashboard
2. Fill in the "Create Browser Profile" form:
   - Email: Gmail address
   - Password: Gmail password
   - Recovery Email: Optional
   - Proxy details: Static residential proxy (1:1 mapping)
3. Click "Create Profile"
4. The system will automatically:
   - Create the AdsPower profile
   - Run DNA Analysis (scrape Gmail, analyze persona)
   - Tag the profile with persona data

### Running DNA Analysis

DNA Analysis (Module A) automatically runs on profile creation. You can also run it manually:
- Click "DNA Analysis" button on a profile card
- This will:
  - Log into Gmail
  - Scrape last 40 emails
  - Use OpenAI to analyze persona (gender, age, interests)
  - Update AdsPower profile notes

### Running Diagnostics

Quality Control (Module B) checks account health:
- Click "Diagnostics" button on a profile card
- Checks:
  - Trust Score (antcpt.com) - should be >= 0.9
  - Persona Integrity (myadcenter.google.com) - personalized ads should be ON
  - YouTube Shadowban (optional, can be done last)

### Daily Farming

Farming (Module C) maintains cookie maturity:
- Click "Farm" button on a profile card
- Or create a campaign to farm multiple profiles
- Activities:
  - Browse RSS feeds matching profile persona
  - Create Google Doc and type content
  - Search Google Maps for "Coffee" near proxy location

### Creating Campaigns

1. Select multiple profiles from the dropdown
2. Choose action: Farm, Diagnostics, or DNA Analysis
3. Click "Run Campaign"
4. System processes up to 10 profiles concurrently

## Architecture

### Modules

- **Module A (DNA Analysis)**: Analyzes Gmail history to determine persona
- **Module B (Doctor)**: Quality control and health checks
- **Module C (Farmer)**: Daily maintenance and cookie maturation

### Queue System

- Maximum 10 concurrent profiles
- Automatic queue management
- Real-time status updates

### Human Emulation

- Cubic Bézier curve mouse movements
- Variable typing speed with typos
- Reading jitter (micro-scrolls)
- Random delays between actions

## Troubleshooting

### AdsPower Connection Issues
- Ensure AdsPower is running
- Check API URL in `.env` (default: http://localhost:50325)
- Verify profile IDs match AdsPower

### MongoDB Connection
- Check MongoDB is running
- Verify connection string in `.env`
- Check network/firewall settings

### Proxy Errors
- Profiles with network errors are automatically flagged
- Check proxy credentials and connectivity
- Failed profiles are skipped in farming

### OpenAI API Errors
- Verify API key is valid
- Check API quota/limits
- Check network connectivity

## Notes

- Profiles are stored in MongoDB
- All interactions are logged
- Trust scores are tracked over time
- Network errors are automatically detected and flagged
- Shadowban check is optional (can be done last)
