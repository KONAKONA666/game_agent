const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 2567;
const app = express();
app.use(express.static(path.join(__dirname, '..')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

class GameRoom {
  constructor() {
    this.clients = new Map(); // ws -> sessionId
    this.players = {};        // sessionId -> player state
    this.coins = [];
    this.startTime = Date.now();
    this.playerCounter = 0;
    this.gameOver = false;
    this.generateCoins();
  }

  generateCoins() {
    const totalCoins = 30;
    const islandCount = 7;
    const cfg = {
      minRadius: 4, maxRadius: 10,
      minHeight: 2, maxHeight: 25,
      centerRadius: 10
    };

    // Generate island centers
    const islands = [];
    // Center island
    islands.push({ x: 0, y: 5, z: 0, radius: cfg.centerRadius });
    // Surrounding islands
    for (let i = 1; i < islandCount; i++) {
      const angle = (i / (islandCount - 1)) * Math.PI * 2;
      const dist = 20 + Math.random() * 15;
      const radius = cfg.minRadius + Math.random() * (cfg.maxRadius - cfg.minRadius);
      const height = cfg.minHeight + Math.random() * (cfg.maxHeight - cfg.minHeight);
      islands.push({
        x: Math.cos(angle) * dist,
        y: height,
        z: Math.sin(angle) * dist,
        radius
      });
    }

    // Distribute coins across islands
    for (let i = 0; i < totalCoins; i++) {
      const island = islands[i % islandCount];
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * island.radius * 0.7;
      this.coins.push({
        id: 'coin_' + i,
        x: island.x + Math.cos(angle) * dist,
        y: island.y + 1.5,
        z: island.z + Math.sin(angle) * dist,
        collected: false
      });
    }
  }

  addPlayer(ws) {
    this.playerCounter++;
    const sessionId = 'p' + this.playerCounter;
    this.clients.set(ws, sessionId);

    const spawn = { x: 0, y: 10, z: 0 };
    this.players[sessionId] = {
      x: spawn.x, y: spawn.y, z: spawn.z,
      vx: 0, vy: 0, vz: 0,
      score: 0,
      grounded: false
    };

    // Send session ID
    this.send(ws, '__sessionId', { sessionId });

    // Send current game state
    this.send(ws, 'gameState', {
      players: this.players,
      coins: this.coins,
      elapsed: (Date.now() - this.startTime) / 1000
    });

    // Broadcast player joined to all others
    this.broadcast('playerJoined', {
      sessionId,
      x: spawn.x, y: spawn.y, z: spawn.z
    }, ws);

    return sessionId;
  }

  removePlayer(ws) {
    const sessionId = this.clients.get(ws);
    if (!sessionId) return;

    this.clients.delete(ws);
    delete this.players[sessionId];

    this.broadcast('playerLeave', { sessionId });
  }

  handleMessage(ws, message) {
    if (this.gameOver) return;

    const sessionId = this.clients.get(ws);
    if (!sessionId || !this.players[sessionId]) return;

    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      return;
    }

    const { type, data } = msg;

    switch (type) {
      case 'playerMove':
        this.handlePlayerMove(sessionId, data, ws);
        break;
      case 'playerJump':
        this.handlePlayerJump(sessionId, data, ws);
        break;
      case 'collectCoin':
        this.handleCollectCoin(sessionId, data);
        break;
    }
  }

  handlePlayerMove(sessionId, data, senderWs) {
    const player = this.players[sessionId];
    if (!player) return;

    player.x = data.x;
    player.y = data.y;
    player.z = data.z;
    player.vx = data.vx || 0;
    player.vy = data.vy || 0;
    player.vz = data.vz || 0;
    if (data.grounded !== undefined) player.grounded = data.grounded;

    // Check fall death
    if (player.y < -20) {
      player.x = 0;
      player.y = 10;
      player.z = 0;
      player.vx = 0;
      player.vy = 0;
      player.vz = 0;
    }

    // Relay to other clients
    this.broadcast('gameState', {
      players: this.players,
      coins: this.coins,
      elapsed: (Date.now() - this.startTime) / 1000
    });
  }

  handlePlayerJump(sessionId, data, senderWs) {
    const player = this.players[sessionId];
    if (!player) return;

    player.x = data.x;
    player.y = data.y;
    player.z = data.z;
    player.grounded = false;
  }

  handleCollectCoin(sessionId, data) {
    const player = this.players[sessionId];
    if (!player) return;

    const coin = this.coins.find(c => c.id === data.coinId);
    if (!coin || coin.collected) return;

    // Check pickup distance
    const dx = player.x - coin.x;
    const dy = player.y - coin.y;
    const dz = player.z - coin.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > 1.8) return;

    coin.collected = true;
    player.score++;

    this.broadcast('coinCollected', {
      coinId: coin.id,
      playerId: sessionId,
      score: player.score
    });

    // Check win condition
    const allCollected = this.coins.every(c => c.collected);
    if (allCollected) {
      this.gameOver = true;
      const scores = {};
      for (const [sid, p] of Object.entries(this.players)) {
        scores[sid] = p.score;
      }

      // Find winner (highest score)
      let winnerId = sessionId;
      let maxScore = 0;
      for (const [sid, score] of Object.entries(scores)) {
        if (score > maxScore) {
          maxScore = score;
          winnerId = sid;
        }
      }

      this.broadcast('gameOver', {
        winnerId,
        scores,
        timeElapsed: (Date.now() - this.startTime) / 1000
      });
    }
  }

  send(ws, type, data) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  broadcast(type, data, excludeWs) {
    const msg = JSON.stringify({ type, data });
    for (const [ws] of this.clients) {
      if (ws !== excludeWs && ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }
}

const room = new GameRoom();

wss.on('connection', (ws) => {
  const sessionId = room.addPlayer(ws);
  console.log(`Player ${sessionId} connected`);

  ws.on('message', (message) => {
    room.handleMessage(ws, message.toString());
  });

  ws.on('close', () => {
    console.log(`Player ${sessionId} disconnected`);
    room.removePlayer(ws);
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${sessionId}:`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Game server running on http://localhost:${PORT}`);
});
