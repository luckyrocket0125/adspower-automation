import { getDB } from '../services/mongodb.js';
import { dbConfig } from '../config/database.js';

export class Profile {
  constructor(data) {
    this.adspowerId = data.adspowerId;
    this.email = data.email;
    this.password = data.password;
    this.recoveryEmail = data.recoveryEmail;
    this.proxy = data.proxy;
    this.persona = data.persona || {};
    this.trustScore = data.trustScore || 0;
    this.status = data.status || 'pending';
    this.notes = data.notes || '';
    this.createdAt = data.createdAt || new Date();
    this.lastFarmed = data.lastFarmed || null;
    this.networkError = data.networkError || false;
  }

  async save() {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.profiles);
    return await collection.insertOne(this);
  }

  static async findById(adspowerId) {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.profiles);
    return await collection.findOne({ adspowerId });
  }

  static async findAll(filter = {}) {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.profiles);
    return await collection.find(filter).toArray();
  }

  static async update(adspowerId, updates) {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.profiles);
    return await collection.updateOne(
      { adspowerId },
      { $set: { ...updates, updatedAt: new Date() } }
    );
  }

  static async updateTrustScore(adspowerId, score) {
    return await this.update(adspowerId, { trustScore: score });
  }

  static async updateStatus(adspowerId, status) {
    return await this.update(adspowerId, { status });
  }

  static async flagNetworkError(adspowerId, hasError) {
    return await this.update(adspowerId, { networkError: hasError });
  }

  static async updatePersona(adspowerId, persona) {
    return await this.update(adspowerId, { persona });
  }
}
