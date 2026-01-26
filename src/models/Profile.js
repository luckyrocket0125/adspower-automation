import { getDB } from '../services/mongodb.js';
import { dbConfig } from '../config/database.js';

export class Profile {
  constructor(data) {
    this.adspowerId = data.adspowerId;
    this.email = data.email;
    this.password = data.password;
    this.recoveryEmail = data.recoveryEmail;
    this.totpSecret = data.totpSecret;
    this.twoFactorCode = data.twoFactorCode;
    this.proxy = data.proxy;
    this.persona = data.persona || {};
    this.trustScore = data.trustScore || 0;
    this.status = data.status || 'pending';
    this.notes = data.notes || '';
    this.groupId = data.groupId || data.group_id || '0';
    this.createdAt = data.createdAt || new Date();
    this.lastFarmed = data.lastFarmed || null;
    this.networkError = data.networkError || false;
    this.userAgent = data.userAgent || data.user_agent || '';
    this.operatingSystem = data.operatingSystem || data.os_type || '';
  }

  async save() {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.profiles);
    // Convert to plain object to ensure all properties are saved
    const profileData = {
      adspowerId: this.adspowerId,
      email: this.email,
      password: this.password,
      recoveryEmail: this.recoveryEmail,
      totpSecret: this.totpSecret,
      twoFactorCode: this.twoFactorCode,
      proxy: this.proxy,
      persona: this.persona,
      trustScore: this.trustScore,
      status: this.status,
      notes: this.notes,
      groupId: this.groupId,
      createdAt: this.createdAt,
      lastFarmed: this.lastFarmed,
      networkError: this.networkError,
      userAgent: this.userAgent,
      operatingSystem: this.operatingSystem
    };
    return await collection.insertOne(profileData);
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
    console.log(`Profile.updateTrustScore called: adspowerId=${adspowerId}, score=${score}`);
    const result = await this.update(adspowerId, { trustScore: score });
    console.log(`Profile.updateTrustScore result:`, {
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      acknowledged: result.acknowledged
    });
    
    // If no document was matched, log a warning
    if (result.matchedCount === 0) {
      console.error(`⚠ WARNING: No profile found with adspowerId: ${adspowerId}`);
      console.error(`  This means the trust score was NOT saved to the profile!`);
    }
    
    return result;
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

  static async delete(adspowerId) {
    const db = getDB();
    const collection = db.collection(dbConfig.collections.profiles);
    return await collection.deleteOne({ adspowerId });
  }
}
