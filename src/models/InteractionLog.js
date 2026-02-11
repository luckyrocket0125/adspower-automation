import { getDB } from '../services/mongodb.js';
import { dbConfig } from '../config/database.js';

export class InteractionLog {
  constructor(data) {
    this.profileId = data.profileId;
    this.action = data.action;
    this.url = data.url;
    this.timestamp = data.timestamp || new Date();
    this.success = data.success || false;
    this.error = data.error || null;
    this.metadata = data.metadata || {};
  }

  async save() {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.interactionLogs);
    return await collection.insertOne(this);
  }

  static async findByProfile(profileId, limit = 100) {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.interactionLogs);
    return await collection
      .find({ profileId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  }

  static async findAll(limit = 500) {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.interactionLogs);
    return await collection
      .find({})
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  }

  /** Returns { [profileId]: { lastDnaAt, lastCheckAt } } for use in Last Used column. */
  static async getLatestActivityByProfile() {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.interactionLogs);
    const logs = await collection
      .find({ action: { $in: ['dna_analysis', 'diagnostics_check'] } })
      .sort({ timestamp: -1 })
      .limit(10000)
      .toArray();
    const map = {};
    for (const log of logs) {
      const id = String(log.profileId);
      if (!map[id]) map[id] = { lastDnaAt: null, lastCheckAt: null };
      if (log.action === 'dna_analysis' && map[id].lastDnaAt == null) map[id].lastDnaAt = log.timestamp;
      if (log.action === 'diagnostics_check' && map[id].lastCheckAt == null) map[id].lastCheckAt = log.timestamp;
    }
    return map;
  }
}
