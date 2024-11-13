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

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Initialize LRU cache with TTL support
const peerCache = new LRU({
  max: 10000, // Increased max items
  maxAge: 24 * 60 * 60 * 1000,
  updateAgeOnGet: false
});

// Track WebSocket connections by hash
const hashSubscriptions = new Map();

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  let subscribedHash = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'subscribe' && data.hash) {
        // Unsubscribe from previous hash if any
        if (subscribedHash) {
          const subs = hashSubscriptions.get(subscribedHash);
          if (subs) {
            subs.delete(ws);
            if (subs.size === 0) hashSubscriptions.delete(subscribedHash);
          }
        }
        
        // Subscribe to new hash
        subscribedHash = data.hash;
        if (!hashSubscriptions.has(subscribedHash)) {
          hashSubscriptions.set(subscribedHash, new Set());
        }
        hashSubscriptions.get(subscribedHash).add(ws);
        
        // Send current peers list
        const peers = peerCache.get(subscribedHash) || [];
        ws.send(JSON.stringify({
          type: 'peers',
          peers: filterActivePeers(peers)
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

// Utility functions
const generateId = () => crypto.randomBytes(16).toString('hex');

const getClientAddress = (req) => {
  const ip = req.headers['x-forwarded-for'] || 
             req.connection.remoteAddress || 
             req.socket.remoteAddress;
  const port = req.connection.remotePort || req.socket.remotePort;
  return `${ip}:${port}`;
};

const filterActivePeers = (peers) => {
  const now = Date.now();
  return peers.filter(peer => {
    const age = now - peer.registeredAt;
    return age < (peer.ttl * 1000);
  }).map(({ name, endpoint, sourceAddress, registeredAt, peerId, metadata }) => ({
    name,
    endpoint,
    sourceAddress,
    peerId,
    metadata,
    age: Math.round((now - registeredAt) / 1000)
  }));
};

const notifyPeerChange = (hash, peers) => {
  const subs = hashSubscriptions.get(hash);
  if (subs) {
    const message = JSON.stringify({
      type: 'peers',
      peers: filterActivePeers(peers)
    });
    subs.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
};

// Validation middleware
const validatePeerData = (req, res, next) => {
  const { name, endpoint, ttl, metadata } = req.body;
  
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Invalid name parameter' });
  }
  
  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({ error: 'Invalid endpoint parameter' });
  }
  
  if (ttl && (!Number.isInteger(ttl) || ttl < 0)) {
    return res.status(400).json({ error: 'Invalid TTL parameter' });
  }
  
  if (metadata && typeof metadata !== 'object') {
    return res.status(400).json({ error: 'Invalid metadata format' });
  }
  
  next();
};

// Subscribe endpoint
app.post('/subscribe/:secretHash', validatePeerData, (req, res) => {
  const { secretHash } = req.params;
  const { name, endpoint, ttl = 300, metadata = {} } = req.body;
  
  let peers = peerCache.get(secretHash) || [];
  peers = peers.filter(peer => peer.name !== name);
  
  const peerData = {
    name,
    endpoint,
    ttl,
    metadata,
    peerId: generateId(),
    sourceAddress: getClientAddress(req),
    registeredAt: Date.now()
  };
  
  peers.push(peerData);
  
  const maxTTL = Math.max(...peers.map(peer => peer.ttl));
  peerCache.set(secretHash, peers, maxTTL * 1000);
  
  // Notify WebSocket subscribers
  notifyPeerChange(secretHash, peers);
  
  res.status(200).json({
    message: 'Successfully registered',
    peerId: peerData.peerId,
    ttl,
    sourceAddress: peerData.sourceAddress
  });
});

// Discovery endpoint
app.get('/discovery/:secretHash', (req, res) => {
  const { secretHash } = req.params;
  const peers = peerCache.get(secretHash) || [];
  const activePeers = filterActivePeers(peers);
  
  if (activePeers.length < peers.length) {
    const maxTTL = Math.max(...activePeers.map(peer => peer.ttl));
    peerCache.set(secretHash, activePeers, maxTTL * 1000);
    notifyPeerChange(secretHash, activePeers);
  }
  
  res.status(200).json({ peers: activePeers });
});

// Heartbeat endpoint
app.post('/heartbeat/:secretHash/:peerId', (req, res) => {
  const { secretHash, peerId } = req.params;
  const peers = peerCache.get(secretHash) || [];
  const peerIndex = peers.findIndex(p => p.peerId === peerId);
  
  if (peerIndex === -1) {
    return res.status(404).json({ error: 'Peer not found' });
  }
  
  peers[peerIndex].registeredAt = Date.now();
  const maxTTL = Math.max(...peers.map(peer => peer.ttl));
  peerCache.set(secretHash, peers, maxTTL * 1000);
  
  res.status(200).json({ message: 'Heartbeat received' });
});

// Unsubscribe endpoint
app.delete('/unsubscribe/:secretHash/:peerId', (req, res) => {
  const { secretHash, peerId } = req.params;
  let peers = peerCache.get(secretHash) || [];
  
  peers = peers.filter(peer => peer.peerId !== peerId);
  
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
  res.status(200).json({
    status: 'healthy',
    cacheSize: peerCache.size,
    activeWebSocketConnections: wss.clients.size,
    activeHashGroups: hashSubscriptions.size,
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Peer discovery service listening on port ${PORT}`);
});
