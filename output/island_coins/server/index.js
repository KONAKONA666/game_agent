const http = require('http');
const { WebSocketServer } = require('ws');
const express = require('express');
const path = require('path');

const app = express();
const PORT = 2567;

// Serve static game files from parent directory
app.use(express.static(path.join(__dirname, '..')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ----- Game Room -----
class GameRoom {
  constructor() {
    this.clients = new Map();
    this.scores = {};
    this.collectedCoins = new Set();
    this.nextId = 1;
  }

  addClient(ws) {
    const sessionId = 'p' + (this.nextId++);
    this.clients.set(ws, { sessionId });
    this.scores[sessionId] = 0;

    // Tell the new client their session ID
    this.sendTo(ws, '__sessionId', sessionId);

    // Send current game state
    this.sendTo(ws, 'gameState', {
      collectedCoins: [...this.collectedCoins],
      scores: { ...this.scores },
      players: [...this.clients.values()].map(c => c.sessionId)
    });

    // Tell everyone else about the new player
    this.broadcast('playerJoined', { sessionId }, ws);
    console.log(`+ ${sessionId} joined (${this.clients.size} players)`);
    return sessionId;
  }

  removeClient(ws) {
    const client = this.clients.get(ws);
    if (!client) return;
    const { sessionId } = client;
    this.clients.delete(ws);
    delete this.scores[sessionId];
    this.broadcast('playerLeave', { sessionId });
    console.log(`- ${sessionId} left (${this.clients.size} players)`);
  }

  handleMessage(ws, type, data) {
    const client = this.clients.get(ws);
    if (!client) return;

    switch (type) {
      case 'playerMove':
        // Relay position to all other clients
        this.broadcast('playerState', {
          sessionId: client.sessionId, ...data
        }, ws);
        break;

      case 'collectCoin':
        if (data.coinId && !this.collectedCoins.has(data.coinId)) {
          this.collectedCoins.add(data.coinId);
          this.scores[client.sessionId] = (this.scores[client.sessionId] || 0) + 1;
          this.broadcast('coinCollected', {
            coinId: data.coinId,
            playerId: client.sessionId
          });
          this.broadcast('scoreUpdate', { scores: { ...this.scores } });
        }
        break;
    }
  }

  broadcast(type, data, except = null) {
    const msg = JSON.stringify({ type, data });
    for (const [ws] of this.clients) {
      if (ws !== except && ws.readyState === 1) ws.send(msg);
    }
  }

  sendTo(ws, type, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
  }
}

const room = new GameRoom();

wss.on('connection', (ws) => {
  const sid = room.addClient(ws);

  ws.on('message', (raw) => {
    try {
      const { type, data } = JSON.parse(raw);
      room.handleMessage(ws, type, data);
    } catch {}
  });

  ws.on('close', () => room.removeClient(ws));
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Game server running on port ' + PORT);
  console.log('  Open http://localhost:' + PORT + ' in your browser');
  console.log('');
});
