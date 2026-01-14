import { startDashboard } from './dashboard/server.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  try {
    await startDashboard();
    console.log('AdsPower Automation System initialized');
  } catch (error) {
    console.error('Initialization error:', error);
    process.exit(1);
  }
}

main();
