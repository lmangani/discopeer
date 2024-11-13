<img src="https://github.com/user-attachments/assets/eaf489d5-0c87-4ed1-a84c-2b116e85762a" width=150 />

# Disco Peer

> A lightweight, real-time peer discovery service for p2p apps
> 
This service allows peers to announce their presence and discover other peers through a simple REST API and WebSocket interface.

## Features

- REST API for peer registration and discovery
- Real-time updates via WebSocket
- Automatic peer expiration with TTL support
- Custom metadata support
- Heartbeat mechanism
- Source IP/Port tracking
- Rate limiting
- CORS support

## Quick Start

### Using Docker

```bash
# Build the image
docker build -t peer-discovery .

# Run the container
docker run -p 3000:3000 peer-discovery
```

### Manual Setup

```bash
# Install dependencies
npm install

# Start the server
npm start
```

## API Usage

### Register a Peer

```bash
curl -X POST http://localhost:3000/subscribe/myhash \
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

```bash
curl http://localhost:3000/discovery/myhash
```

### WebSocket Updates

```javascript
const ws = new WebSocket('ws://localhost:3000');

// Subscribe to updates
ws.send(JSON.stringify({
  type: 'subscribe',
  hash: 'myhash'
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

### WebSocket Events

- `subscribe` - Subscribe to peer updates for a hash
- `peers` - Receive updated peer list


## License

MIT
