const express = require('express');
const LRU = require('lru-cache');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const WebSocket = require('ws');
const http = require('http');

// Create HTTP server
const app = express();
const server = http.createServer(app);

// Initialize WebSocket server for real-time updates
const wss = new WebSocket.Server({ server });

// Enable CORS and JSON parsing
app.use(cors());
app.use(bodyParser.json());

// Redirect root to GitHub project page
app.get('/', (req, res) => {
  res.redirect(301, 'https://github.com/lmangani/discopeer');
});

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Initialize LRU cache with TTL support
const peerCache = new LRU({
  max: 10000,
  maxAge: 24 * 60 * 60 * 1000,
  updateAgeOnGet: false
});

// Track WebSocket connections by hash
const hashSubscriptions = new Map();

// Encryption configuration and utilities
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const encryptionUtils = {
  // Generate encryption key from token using PBKDF2
  deriveKey: (token) => {
    const salt = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    return crypto.pbkdf2Sync(token, salt, 100000, 32, 'sha256');
  },

  // Encrypt data with token
  encrypt: (data, token) => {
    if (!token) return data;
    
    const key = encryptionUtils.deriveKey(token);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data), 'utf8'),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    // Combine IV, encrypted data, and auth tag
    return Buffer.concat([iv, encrypted, authTag])
      .toString('base64');
  },

  // Decrypt data with token
  decrypt: (encryptedData, token) => {
    if (!token) return encryptedData;
    
    try {
      const key = encryptionUtils.deriveKey(token);
      const buffer = Buffer.from(encryptedData, 'base64');
      
      // Extract IV, encrypted data, and auth tag
      const iv = buffer.slice(0, IV_LENGTH);
      const authTag = buffer.slice(buffer.length - AUTH_TAG_LENGTH);
      const encrypted = buffer.slice(IV_LENGTH, buffer.length - AUTH_TAG_LENGTH);
      
      const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]);
      
      return JSON.parse(decrypted.toString('utf8'));
    } catch (error) {
      throw new Error('Invalid token or corrupted data');
    }
  }
};

// Utility functions
const generateId = () => crypto.randomBytes(16).toString('hex');

const getClientAddress = (req) => {
  let ip;
  
  if (req.headers['x-forwarded-for']) {
    const ips = req.headers['x-forwarded-for'].split(',');
    ip = ips[ips.length - 1].trim();
  } else {
    ip = req.socket.remoteAddress;
  }
  
  if (ip) {
    if (ip.startsWith('::ffff:')) {
      ip = ip.substring(7);
    }
    if (ip.includes(',')) {
      ip = ip.split(',').pop().trim();
    }
  }
  
  const port = req.socket.remotePort;
  return `${ip}:${port}`;
};

const filterActivePeers = (peers) => {
  const now = Date.now();
  return peers.filter(peer => {
    if (peer.hasEncryption) return true; // Keep encrypted peers
    const age = now - peer.registeredAt;
    return age < (peer.ttl * 1000);
  }).map(peer => {
    if (peer.hasEncryption) return peer; // Return encrypted peer as-is
    const { name, endpoint, sourceAddress, registeredAt, peerId, metadata } = peer;
    return {
      name,
      endpoint,
      sourceAddress,
      peerId,
      metadata,
      age: Math.round((now - registeredAt) / 1000)
    };
  });
};

const notifyPeerChange = (hash, peers) => {
  const subs = hashSubscriptions.get(hash);
  if (subs) {
    subs.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        // Use the token associated with this connection if available
        const token = ws.token;
        const processedPeers = peers.map(peer => {
          if (peer.hasEncryption) {
            if (!token) {
              return { encrypted: true, peerId: peer.peerId };
            }
            try {
              return encryptionUtils.decrypt(peer.encrypted, token);
            } catch (error) {
              return { encrypted: true, peerId: peer.peerId, error: 'Invalid token' };
            }
          }
          return peer;
        });
        
        ws.send(JSON.stringify({
          type: 'peers',
          peers: filterActivePeers(processedPeers)
        }));
      }
    });
  }
};

const generateDeterministicPeerId = (name, endpoint, sourceAddress) => {
  return crypto
    .createHash('sha256')
    .update(`${name}:${endpoint}`)
    .digest('hex')
    .substring(0, 32);
};

// Validation middleware
const validatePeerData = (req, res, next) => {
  const { name, endpoint, metadata, peerId } = req.body;
  
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Invalid name parameter' });
  }
  
  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({ error: 'Invalid endpoint parameter' });
  }

  if (req.body.ttl) {
    try {
      req.body.ttl = parseInt(req.body.ttl);
      if (req.body.ttl < 0) throw new Error('Parameter is negative!');
    } catch(e) {
      return res.status(400).json({ error: 'Invalid TTL parameter', cause: e.message });
    }
  }

  if (metadata && typeof metadata !== 'object') {
    return res.status(400).json({ error: 'Invalid metadata format' });
  }

  if (peerId && typeof peerId !== 'string') {
    return res.status(400).json({ error: 'Invalid peerId format' });
  }
  
  next();
};

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  let subscribedHash = null;
  
  // Parse token from URL if present
  const url = new URL(req.url, 'http://localhost');
  ws.token = url.searchParams.get('token');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'subscribe' && data.hash) {
        if (subscribedHash) {
          const subs = hashSubscriptions.get(subscribedHash);
          if (subs) {
            subs.delete(ws);
            if (subs.size === 0) hashSubscriptions.delete(subscribedHash);
          }
        }
        
        subscribedHash = data.hash;
        if (!hashSubscriptions.has(subscribedHash)) {
          hashSubscriptions.set(subscribedHash, new Set());
        }
        hashSubscriptions.get(subscribedHash).add(ws);
        
        const peers = peerCache.get(subscribedHash) || [];
        const processedPeers = peers.map(peer => {
          if (peer.hasEncryption) {
            if (!ws.token) {
              return { encrypted: true, peerId: peer.peerId };
            }
            try {
              return encryptionUtils.decrypt(peer.encrypted, ws.token);
            } catch (error) {
              return { encrypted: true, peerId: peer.peerId, error: 'Invalid token' };
            }
          }
          return peer;
        });
        
        ws.send(JSON.stringify({
          type: 'peers',
          peers: filterActivePeers(processedPeers)
        }));
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => {
    if (subscribedHash) {
      const subs = hashSubscriptions.get(subscribedHash);
      if (subs) {
        subs.delete(ws);
        if (subs.size === 0) hashSubscriptions.delete(subscribedHash);
      }
    }
  });
});

// Subscribe endpoint
app.post('/subscribe/:secretHash', validatePeerData, (req, res) => {
  const { secretHash } = req.params;
  const { name, endpoint, ttl = 300, metadata = {}, peerId: clientProvidedPeerId } = req.body;
  const token = req.query.token;
  
  const sourceAddress = getClientAddress(req);
  const peerId = clientProvidedPeerId || generateDeterministicPeerId(name, endpoint, sourceAddress);
  
  let peers = peerCache.get(secretHash) || [];
  peers = peers.filter(peer => peer.peerId !== peerId);
  
  const peerData = {
    name,
    endpoint,
    ttl,
    metadata,
    peerId,
    sourceAddress,
    registeredAt: Date.now()
  };
  
  // If token is provided, encrypt the peer data
  const dataToStore = token ? 
    { encrypted: encryptionUtils.encrypt(peerData, token), hasEncryption: true, peerId, ttl } : 
    peerData;
  
  peers.push(dataToStore);
  
  const maxTTL = Math.max(...peers.map(peer => peer.ttl));
  peerCache.set(secretHash, peers, maxTTL * 1000);
  
  notifyPeerChange(secretHash, peers);
  
  res.status(200).json({
    message: 'Successfully registered',
    peerId,
    ttl,
    sourceAddress,
    encrypted: !!token
  });
});

// Discovery endpoint
app.get('/discovery/:secretHash', (req, res) => {
  const { secretHash } = req.params;
  const token = req.query.token;
  const peers = peerCache.get(secretHash) || [];
  
  const processedPeers = peers.map(peer => {
    if (peer.hasEncryption) {
      if (!token) {
        return { encrypted: true, peerId: peer.peerId };
      }
      try {
        return encryptionUtils.decrypt(peer.encrypted, token);
      } catch (error) {
        return { encrypted: true, peerId: peer.peerId, error: 'Invalid token' };
      }
    }
    return peer;
  });
  
  const activePeers = filterActivePeers(processedPeers);
  
  if (activePeers.length < peers.length) {
    const maxTTL = Math.max(...activePeers.map(peer => peer.ttl));
    peerCache.set(secretHash, activePeers, maxTTL * 1000);
    notifyPeerChange(secretHash, activePeers);
  }
  
  res.status(200).json({ peers: activePeers });
});

// NDJSON discovery endpoint
app.get('/discovery/:secretHash/ndjson', (req, res) => {
  const { secretHash } = req.params;
  const token = req.query.token;
  const peers = peerCache.get(secretHash) || [];
  
  const processedPeers = peers.map(peer => {
    if (peer.hasEncryption) {
      if (!token) {
        return { encrypted: true, peerId: peer.peerId };
      }
      try {
        return encryptionUtils.decrypt(peer.encrypted, token);
      } catch (error) {
        return { encrypted: true, peerId: peer.peerId, error: 'Invalid token' };
      }
    }
    return peer;
  });
  
  const activePeers = filterActivePeers(processedPeers);
  
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  activePeers.forEach(peer => {
    res.write(JSON.stringify(peer) + '\n');
  });
  
  if (activePeers.length < peers.length) {
    const maxTTL = Math.max(...activePeers.map(peer => peer.ttl));
    peerCache.set(secretHash, activePeers, maxTTL * 1000);
    notifyPeerChange(secretHash, activePeers);
  }
  
  res.end();
});

// Heartbeat endpoint
app.post('/heartbeat/:secretHash/:peerId', (req, res) => {
  const { secretHash, peerId } = req.params;
  const token = req.query.token;
  const peers = peerCache.get(secretHash) || [];
  const peerIndex = peers.findIndex(p => p.peerId === peerId);
  
  if (peerIndex === -1) {
    return res.status(404).json({ error: 'Peer not found' });
  }
  
  // For encrypted peers, verify token matches
  if (peers[peerIndex].hasEncryption) {
    if (!token) {
      return res.status(403).json({ error: 'Token required for encrypted peer' });
    }
    try {
      encryptionUtils.decrypt(peers[peerIndex].encrypted, token);
    } catch (error) {
      return res.status(403).json({ error: 'Invalid token' });
    }
  }
  
  peers[peerIndex].registeredAt = Date.now();
  const maxTTL = Math.max(...peers.map(peer => peer.ttl));
  peerCache.set(secretHash, peers, maxTTL * 1000);
  
  res.status(200).json({ message: 'Heartbeat received' });
});

// Unsubscribe endpoint
app.delete('/unsubscribe/:secretHash/:peerId', (req, res) => {
  const { secretHash, peerId } = req.params;
  const token = req.query.token;
  let peers = peerCache.get(secretHash) || [];
  
  const peer = peers.find(p => p.peerId === peerId);
  if (!peer) {
    return res.status(404).json({ error: 'Peer not found' });
  }
  
  // For encrypted peers, verify token
  if (peer.hasEncryption) {
    if (!token) {
      return res.status(403).json({ error: 'Token required for encrypted peer' });
    }
    try {
      encryptionUtils.decrypt(peer.encrypted, token);
    } catch (error) {
      return res.status(403).json({ error: 'Invalid token' });
    }
  }
  
  peers = peers.filter(p => p.peerId !== peerId);
  
  if (peers.length > 0) {
    const maxTTL = Math.max(...peers.map(peer => peer.ttl));
    peerCache.set(secretHash, peers, maxTTL * 1000);
  } else {
    peerCache.del(secretHash);
  }
  
  notifyPeerChange(secretHash, peers);
  
  res.status(200).json({ message: 'Successfully unsubscribed' });
});

// Health check endpoint with enhanced metrics
app.get('/health', (req, res) => {
  const metrics = {
    status: 'healthy',
    cacheSize: peerCache.size,
    activeWebSocketConnections: wss.clients.size,
    activeHashGroups: hashSubscriptions.size,
    encryptedPeers: Array.from(peerCache.values()).flat().filter(peer => peer.hasEncryption).length,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  };
  
  res.status(200).json(metrics);
});

// Debug endpoint (disabled in production)
if (process.env.NODE_ENV !== 'production') {
  app.get('/debug/:secretHash', (req, res) => {
    const { secretHash } = req.params;
    const peers = peerCache.get(secretHash) || [];
    res.status(200).json({
      totalPeers: peers.length,
      encryptedPeers: peers.filter(p => p.hasEncryption).length,
      subscriptions: hashSubscriptions.has(secretHash) ? 
        hashSubscriptions.get(secretHash).size : 0
    });
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  
  // Handle encryption-related errors
  if (err.message && err.message.includes('Invalid token')) {
    return res.status(403).json({
      error: 'Encryption error',
      message: 'Invalid token provided'
    });
  }
  
  // Handle rate limit errors
  if (err.status === 429) {
    return res.status(429).json({
      error: 'Too many requests',
      message: 'Please try again later'
    });
  }
  
  // Default error response
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 
      'An unexpected error occurred' : err.message
  });
});

// Graceful shutdown handler
const shutdown = () => {
  console.log('Shutting down gracefully...');
  
  // Close WebSocket server
  wss.close(() => {
    console.log('WebSocket server closed');
    
    // Close HTTP server
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
    
    // Force close after 10s
    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Peer discovery service listening on port ${PORT}`);
  console.log(`Encryption support enabled`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Export for testing
module.exports = { app, server, peerCache, hashSubscriptions, encryptionUtils };
