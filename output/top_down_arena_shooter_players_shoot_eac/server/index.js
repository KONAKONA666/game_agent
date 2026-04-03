const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 2567;

const SPAWN_POINTS = [
  { x: -12, z: -12 },
  { x: 12, z: -12 },
  { x: -12, z: 12 },
  { x: 12, z: 12 },
];

const MAX_HEALTH = 100;
const RESPAWN_DELAY_MS = 2000;
const INVINCIBILITY_MS = 1500;
const KILL_SCORE = 1;

class GameRoom {
  constructor() {
    this.clients = new Map(); // ws -> sessionId
    this.players = {};        // sessionId -> { x, z, rotation, health, score, alive, invincible }
    this.nextId = 1;
  }

  getSessionId() {
    return 'p' + this.nextId++;
  }

  getSpawnPoint() {
    const sp = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
    return { x: sp.x, z: sp.z };
  }

  addClient(ws) {
    const sessionId = this.getSessionId();
    this.clients.set(ws, sessionId);

    const spawn = this.getSpawnPoint();
    this.players[sessionId] = {
      x: spawn.x,
      z: spawn.z,
      rotation: 0,
      health: MAX_HEALTH,
      score: 0,
      alive: true,
      invincible: true,
    };

    // Remove invincibility after timeout
    setTimeout(() => {
      if (this.players[sessionId]) {
        this.players[sessionId].invincible = false;
      }
    }, INVINCIBILITY_MS);

    // Send session ID
    this.send(ws, '__sessionId', { sessionId });

    // Send current game state
    const playersState = {};
    for (const [sid, p] of Object.entries(this.players)) {
      playersState[sid] = { x: p.x, z: p.z, rotation: p.rotation, health: p.health, score: p.score };
    }
    this.send(ws, 'gameState', { players: playersState });

    // Broadcast player joined
    this.broadcast('playerJoined', { sessionId, x: spawn.x, z: spawn.z }, ws);

    return sessionId;
  }

  removeClient(ws) {
    const sessionId = this.clients.get(ws);
    if (!sessionId) return;

    this.clients.delete(ws);
    delete this.players[sessionId];

    this.broadcast('playerLeave', { sessionId });
  }

  handleMessage(ws, message) {
    const sessionId = this.clients.get(ws);
    if (!sessionId) return;

    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (e) {
      return;
    }

    const { type, data } = parsed;
    const player = this.players[sessionId];
    if (!player) return;

    switch (type) {
      case 'playerMove':
        player.x = data.x;
        player.z = data.z;
        player.rotation = data.rotation;
        this.broadcast('playerMoved', {
          sessionId,
          x: data.x,
          z: data.z,
          rotation: data.rotation,
        }, ws);
        break;

      case 'playerShoot':
        this.broadcast('playerShot', {
          sessionId,
          originX: data.originX,
          originZ: data.originZ,
          dirX: data.dirX,
          dirZ: data.dirZ,
        }, ws);
        break;

      case 'hit':
        this.handleHit(sessionId, data);
        break;
    }
  }

  handleHit(attackerSessionId, data) {
    const { victimSessionId, damage } = data;
    const victim = this.players[victimSessionId];
    const attacker = this.players[attackerSessionId];
    if (!victim || !attacker) return;
    if (!victim.alive || victim.invincible) return;

    victim.health -= damage;
    if (victim.health < 0) victim.health = 0;

    this.broadcast('playerHit', {
      victimSessionId,
      attackerSessionId,
      newHealth: victim.health,
    });

    if (victim.health <= 0) {
      victim.alive = false;
      attacker.score += KILL_SCORE;

      this.broadcast('playerDied', {
        victimSessionId,
        killerSessionId: attackerSessionId,
      });

      // Broadcast score update
      const scores = {};
      for (const [sid, p] of Object.entries(this.players)) {
        scores[sid] = p.score;
      }
      this.broadcast('scoreUpdate', { scores });

      // Respawn after delay
      setTimeout(() => {
        if (!this.players[victimSessionId]) return;
        const spawn = this.getSpawnPoint();
        victim.x = spawn.x;
        victim.z = spawn.z;
        victim.health = MAX_HEALTH;
        victim.alive = true;
        victim.invincible = true;

        this.broadcast('playerJoined', {
          sessionId: victimSessionId,
          x: spawn.x,
          z: spawn.z,
        });

        setTimeout(() => {
          if (this.players[victimSessionId]) {
            this.players[victimSessionId].invincible = false;
          }
        }, INVINCIBILITY_MS);
      }, RESPAWN_DELAY_MS);
    }
  }

  send(ws, type, data) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  broadcast(type, data, excludeWs) {
    const msg = JSON.stringify({ type, data });
    for (const [client] of this.clients) {
      if (client !== excludeWs && client.readyState === 1) {
        client.send(msg);
      }
    }
  }
}

// Setup
const app = express();
app.use(express.static(path.join(__dirname, '..')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const room = new GameRoom();

wss.on('connection', (ws) => {
  const sessionId = room.addClient(ws);
  console.log(`Player connected: ${sessionId}`);

  ws.on('message', (msg) => {
    room.handleMessage(ws, msg.toString());
  });

  ws.on('close', () => {
    console.log(`Player disconnected: ${sessionId}`);
    room.removeClient(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Game server running on http://localhost:${PORT}`);
});
