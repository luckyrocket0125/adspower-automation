# AdsPower Automation Profile Management System

Browser automation and anti-detect system for building a robust Profile Management & Cookie Maturation System using AdsPower API.

## Features

- **Profile Management**: Automated browser profile lifecycle management
- **Bulk Profile Creation**: Create multiple profiles at once from proxy list (1:1 mapping)
- **DNA Analysis**: AI-powered persona detection from Gmail history
- **Quality Control**: Trust score monitoring and account health checks
- **Daily Farming**: Human-like browsing patterns for cookie maturation
- **Queue System**: Concurrent profile management (max 10 simultaneous)

## Tech Stack

- Node.js
- Puppeteer (via AdsPower WebSocket)
- MongoDB
- OpenAI API (gpt-4o-mini)
- Express (Web Dashboard)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in your API keys

3. Start MongoDB (if running locally)

4. Run the application:
```bash
npm start
```

5. Access the dashboard at `http://localhost:3000`

## Bulk Profile Creation

The system supports bulk creation of profiles from a proxy list with 1:1 mapping:

1. Go to the dashboard
2. Use the "Bulk Create Profiles" section
3. Paste your accounts (format: `email:password:recoveryEmail`, one per line)
4. Paste your proxies (format: `host:port:username:password`, one per line)
5. The system will automatically:
   - Match first account with first proxy (1:1 mapping)
   - Create AdsPower profiles
   - Run DNA analysis for each profile
   - Process up to 10 profiles concurrently

See `BULK_IMPORT_EXAMPLE.txt` for format examples.

## Project Structure

```
src/
├── index.js                 # Main entry point
├── config/                  # Configuration files
├── services/                # Core services
│   ├── adspower.js         # AdsPower API integration
│   ├── mongodb.js          # Database connection
│   ├── openai.js           # OpenAI integration
│   └── smspool.js          # SMSPool integration
├── modules/                 # Functional modules
│   ├── dnaAnalysis.js      # Module A: DNA Analysis
│   ├── doctor.js           # Module B: Quality Control
│   └── farmer.js           # Module C: Daily Farming
├── utils/                   # Utilities
│   ├── queue.js            # Queue/concurrency manager
│   ├── humanEmulation.js   # Human-like behavior
│   └── proxy.js            # Proxy management
└── dashboard/               # Web dashboard
    ├── server.js           # Express server
    └── public/             # Frontend files
```
