const fs = require('fs').promises;
const path = require('path');

class PersistenceManager {
  constructor(options = {}) {
    this.filename = options.filename || path.join(__dirname, 'data', 'peer-cache.json');
    this.cache = null;
  }

  async init(cache) {
    this.cache = cache;
    await this.ensureDataDirectory();
    await this.load();
  }

  async ensureDataDirectory() {
    const dir = path.dirname(this.filename);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
    }
  }

  async load() {
    try {
      const data = await fs.readFile(this.filename, 'utf8');
      const cached = JSON.parse(data);
      
      // Reconstruct cache with TTL checks
      const now = Date.now();
      Object.entries(cached).forEach(([hash, peers]) => {
        // Filter out expired peers during load
        const activePeers = peers.filter(peer => {
          const age = now - peer.registeredAt;
          return age < (peer.ttl * 1000);
        });
        
        if (activePeers.length > 0) {
          const maxTTL = Math.max(...activePeers.map(peer => peer.ttl));
          this.cache.set(hash, activePeers, maxTTL * 1000);
        }
      });
      
      console.log(`Loaded ${this.cache.size} peer groups from ${this.filename}`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Error loading peer cache:', err);
      }
    }
  }

  async save() {
    try {
      const dump = {};
      for (const [hash, peers] of this.cache.entries()) {
        dump[hash] = peers;
      }
      
      await fs.writeFile(this.filename, JSON.stringify(dump, null, 2), 'utf8');
      console.log(`Saved ${this.cache.size} peer groups to ${this.filename}`);
    } catch (err) {
      console.error('Error saving peer cache:', err);
    }
  }

  async shutdown() {
    await this.save();
  }

  getStats() {
    return {
      persistenceFile: this.filename,
      cacheSize: this.cache?.size || 0
    };
  }
}

module.exports = PersistenceManager;
