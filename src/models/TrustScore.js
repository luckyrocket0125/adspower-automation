import { getDB } from '../services/mongodb.js';
import { dbConfig } from '../config/database.js';

export class TrustScore {
  constructor(data) {
    this.profileId = data.profileId;
    this.score = data.score;
    this.source = data.source;
    this.timestamp = data.timestamp || new Date();
    this.metadata = data.metadata || {};
  }

  async save() {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.trustScores);
    return await collection.insertOne(this);
  }

  static async getLatest(profileId) {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.trustScores);
    return await collection
      .findOne(
        { profileId },
        { sort: { timestamp: -1 } }
      );
  }

  static async getHistory(profileId, limit = 30) {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.trustScores);
    return await collection
      .find({ profileId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  }
}
