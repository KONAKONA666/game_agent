export default class Network {
  name = 'network';

  _room = null;
  _sessionId = null;
  _handlers = {};
  _connected = false;
  _fallback = false;
  _ctx = null;

  // Fallback state
  _fbPlayers = {};
  _fbScores = {};
  _fbInterval = null;

  async build(ctx) {
    this._ctx = ctx;

    try {
      const client = new ColyseusClient(ctx.wsUrl);
      this._room = await client.joinOrCreate('game');

      // Wait for __sessionId message
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for __sessionId'));
        }, 5000);

        this._room.onMessage('__sessionId', (payload) => {
          clearTimeout(timeout);
          this._sessionId = payload.sessionId;
          this._connected = true;
          resolve();
        });
      });

      // Forward all server messages to registered handlers
      const serverMessageTypes = [
        'gameState', 'playerJoined', 'playerLeave', 'playerMoved',
        'playerShot', 'playerHit', 'playerDied', 'scoreUpdate'
      ];

      for (const type of serverMessageTypes) {
        this._room.onMessage(type, (payload) => {
          this._dispatch(type, payload);
        });
      }
    } catch (e) {
      console.warn('Network: WebSocket connection failed, using singleplayer fallback.', e);
      this._initFallback();
    }
  }

  start() {
    const ctx = this._ctx;
    ctx.eventBus.dispatchEvent(new CustomEvent('network:connected', {
      detail: { sessionId: this._sessionId, fallback: this._fallback }
    }));
  }

  update(dt) {
    // Nothing needed per-frame
  }

  dispose() {
    if (this._fbInterval) {
      clearInterval(this._fbInterval);
      this._fbInterval = null;
    }
    if (this._room) {
      this._room.leave();
      this._room = null;
    }
    this._handlers = {};
  }

  // --- Public API ---

  send(type, payload) {
    if (this._fallback) {
      this._handleFallbackMessage(type, payload);
      return;
    }
    if (this._room && this._connected) {
      this._room.send(type, payload);
    }
  }

  onMessage(type, cb) {
    if (!this._handlers[type]) {
      this._handlers[type] = [];
    }
    this._handlers[type].push(cb);
  }

  getSessionId() {
    return this._sessionId;
  }

  // --- Internal ---

  _dispatch(type, payload) {
    const ctx = this._ctx;

    // Forward join/leave to eventBus
    if (type === 'playerJoined') {
      ctx.eventBus.dispatchEvent(new CustomEvent('network:playerJoined', { detail: payload }));
    } else if (type === 'playerLeave') {
      ctx.eventBus.dispatchEvent(new CustomEvent('network:playerLeft', { detail: payload }));
    }

    const cbs = this._handlers[type];
    if (cbs) {
      for (const cb of cbs) {
        cb(payload);
      }
    }
  }

  // --- Singleplayer Fallback ---

  _initFallback() {
    this._fallback = true;
    this._sessionId = 'solo_' + Math.random().toString(36).slice(2, 10);
    this._connected = true;

    // Init local player state
    const spawnPoints = [
      { x: -12, z: -12 }, { x: 12, z: -12 },
      { x: -12, z: 12 }, { x: 12, z: 12 }
    ];
    const spawn = spawnPoints[0];

    this._fbPlayers[this._sessionId] = {
      x: spawn.x, z: spawn.z, rotation: 0,
      health: 100, score: 0
    };
    this._fbScores[this._sessionId] = 0;

    // Broadcast gameState every 50ms
    this._fbInterval = setInterval(() => {
      this._dispatch('gameState', { players: { ...this._fbPlayers } });
    }, 50);

    // Dispatch initial playerJoined after a tick so handlers can register
    setTimeout(() => {
      this._dispatch('playerJoined', {
        sessionId: this._sessionId,
        x: spawn.x, z: spawn.z
      });
    }, 0);
  }

  _handleFallbackMessage(type, payload) {
    const sid = this._sessionId;

    switch (type) {
      case 'playerMove': {
        const p = this._fbPlayers[sid];
        if (p) {
          p.x = payload.x;
          p.z = payload.z;
          p.rotation = payload.rotation;
          this._dispatch('playerMoved', {
            sessionId: sid,
            x: payload.x, z: payload.z, rotation: payload.rotation
          });
        }
        break;
      }

      case 'playerShoot': {
        this._dispatch('playerShot', {
          sessionId: sid,
          originX: payload.originX, originZ: payload.originZ,
          dirX: payload.dirX, dirZ: payload.dirZ
        });
        break;
      }

      case 'hit': {
        const victim = this._fbPlayers[payload.victimSessionId];
        if (!victim) break;

        victim.health -= payload.damage;
        const newHealth = Math.max(victim.health, 0);
        victim.health = newHealth;

        this._dispatch('playerHit', {
          victimSessionId: payload.victimSessionId,
          attackerSessionId: sid,
          newHealth: newHealth
        });

        if (newHealth <= 0) {
          // Player died
          this._fbScores[sid] = (this._fbScores[sid] || 0) + 1;
          const p = this._fbPlayers[sid];
          if (p) p.score = this._fbScores[sid];

          this._dispatch('playerDied', {
            victimSessionId: payload.victimSessionId,
            killerSessionId: sid
          });

          this._dispatch('scoreUpdate', {
            scores: { ...this._fbScores }
          });

          // Respawn victim after delay
          const spawnPoints = [
            { x: -12, z: -12 }, { x: 12, z: -12 },
            { x: -12, z: 12 }, { x: 12, z: 12 }
          ];
          const spawnIdx = Math.floor(Math.random() * spawnPoints.length);
          const sp = spawnPoints[spawnIdx];

          setTimeout(() => {
            if (this._fbPlayers[payload.victimSessionId]) {
              this._fbPlayers[payload.victimSessionId].health = 100;
              this._fbPlayers[payload.victimSessionId].x = sp.x;
              this._fbPlayers[payload.victimSessionId].z = sp.z;
            }
          }, 2000);
        }
        break;
      }

      default:
        break;
    }
  }
}
