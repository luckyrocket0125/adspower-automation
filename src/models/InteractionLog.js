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
}
