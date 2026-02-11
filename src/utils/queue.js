export class ProfileQueue {
  constructor(maxConcurrent = 10) {
    this.maxConcurrent = maxConcurrent;
    this.running = new Set();
    this.queue = [];
    this.processing = false;
    this.lastStartTime = 0;
    this.minDelayBetweenStarts = 1000; // 1 second minimum delay between starting profiles
  }

  async add(profileId, task) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        profileId,
        task,
        resolve,
        reject
      });
      this.process();
    });
  }

  async process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0 && this.running.size < this.maxConcurrent) {
      const item = this.queue.shift();
      
      // Add delay to prevent rate limiting when starting multiple profiles
      const timeSinceLastStart = Date.now() - this.lastStartTime;
      if (timeSinceLastStart < this.minDelayBetweenStarts) {
        const delayNeeded = this.minDelayBetweenStarts - timeSinceLastStart;
        await new Promise(resolve => setTimeout(resolve, delayNeeded));
      }
      this.lastStartTime = Date.now();
      
      this.running.add(item.profileId);

      item.task()
        .then(result => {
          this.running.delete(item.profileId);
          item.resolve(result);
          this.process();
        })
        .catch(error => {
          this.running.delete(item.profileId);
          item.reject(error);
          this.process();
        });
    }

    this.processing = false;
  }

  getStatus() {
    return {
      running: Array.from(this.running),
      queued: this.queue.length,
      active: this.running.size,
      maxConcurrent: this.maxConcurrent
    };
  }

  clear() {
    this.queue = [];
    this.running.clear();
  }
}
