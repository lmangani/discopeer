<img src="https://github.com/user-attachments/assets/eaf489d5-0c87-4ed1-a84c-2b116e85762a" width=150 />

# Disco Peer
> A lightweight, real-time peer discovery service for p2p apps with optional encryption support

This service allows peers to announce their presence and discover other peers through a simple REST API and WebSocket interface.

## Features
- REST API for peer registration and discovery
- Real-time updates via WebSocket
- Optional end-to-end encryption for peer data
- Automatic peer expiration with TTL support
- Custom metadata support
- Heartbeat mechanism
- Source IP/Port tracking
- Rate limiting
- CORS support

## Quick Start

### Register a Peer

#### Without Encryption
```bash
secretHash=$(shuf -er -n20  {A..Z} {a..z} {0..9} | tr -d '\n')
echo $secretHash
curl -X POST "https://discopeer.fly.dev/subscribe/$secretHash" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "service1",
    "endpoint": "http://192.168.1.100:8080",
    "ttl": 300,
    "metadata": {
      "region": "us-east"
    }
  }'
```

#### With Encryption
```bash
token="yoursecrettoken"
curl -X POST "https://discopeer.fly.dev/subscribe/$secretHash?token=$token" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "service1",
    "endpoint": "http://192.168.1.100:8080",
    "ttl": 300,
    "metadata": {
      "region": "us-east"
    }
  }'
```

### Discover Peers

#### Without Encryption
```bash
curl "https://discopeer.fly.dev/discovery/$secretHash"
```

#### With Encryption
```bash
curl "https://discopeer.fly.dev/discovery/$secretHash?token=$token"
```

### WebSocket Updates

#### Without Encryption
```javascript
const secretHash = 'somesupersafestuff'
const ws = new WebSocket('wss://discopeer.fly.dev');
// Subscribe to updates
ws.send(JSON.stringify({
  type: 'subscribe',
  hash: secretHash
}));
// Listen for peer updates
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'peers') {
    console.log('Updated peers:', data.peers);
  }
};
```

#### With Encryption
```javascript
const secretHash = 'somesupersafestuff'
const token = 'yoursecrettoken'
const ws = new WebSocket(`wss://discopeer.fly.dev?token=${token}`);
// Subscribe to updates
ws.send(JSON.stringify({
  type: 'subscribe',
  hash: secretHash
}));
// Listen for peer updates
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'peers') {
    console.log('Updated peers:', data.peers);
  }
};
```

## API Reference

### REST Endpoints
- `POST /subscribe/{secretHash}` - Register a peer
- `GET /discovery/{secretHash}` - Get list of active peers
- `POST /heartbeat/{secretHash}/{peerId}` - Send heartbeat
- `DELETE /unsubscribe/{secretHash}/{peerId}` - Remove peer
- `GET /health` - Service health check

All endpoints support optional encryption via the `token` query parameter.

### Encryption Support
Add `?token=yoursecrettoken` to any endpoint to enable end-to-end encryption:
- Peers registered with a token will have their data encrypted
- Only clients providing the same token can decrypt the peer data
- Encrypted peers appear as `{ encrypted: true, peerId: "..." }` to clients without the correct token
- Mixed encrypted and unencrypted peers can coexist in the same hash group

### WebSocket Events
- `subscribe` - Subscribe to peer updates for a hash
- `peers` - Receive updated peer list

### Response Format
```javascript
// Unencrypted peer
{
  "name": "service1",
  "endpoint": "http://192.168.1.100:8080",
  "sourceAddress": "10.0.0.1:12345",
  "peerId": "abc123...",
  "metadata": {
    "region": "us-east"
  },
  "age": 30
}

// Encrypted peer (without token)
{
  "encrypted": true,
  "peerId": "abc123..."
}

// Encrypted peer (with incorrect token)
{
  "encrypted": true,
  "peerId": "abc123...",
  "error": "Invalid token"
}
```

## Security Considerations
- Encryption is performed using AES-256-GCM with unique IVs
- Tokens are never stored, only used for encryption/decryption
- Encrypted peers maintain their TTL and expiration
- Always use HTTPS/WSS in production
- Choose strong tokens and keep them secret

## License
MIT
