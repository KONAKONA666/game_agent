export default class Combat {
  name = 'combat';

  async build(ctx) {
    this.ctx = ctx;
    this.scores = {};
    this.healthMap = {};
    this.invincibleUntil = {};
    this.deadPlayers = new Set();

    const players = ctx.modules.player.getAllPlayers();
    for (const [sid] of players) {
      this.scores[sid] = 0;
      this.healthMap[sid] = 100;
    }

    const localId = ctx.modules.network.getSessionId();
    if (localId && !(localId in this.scores)) {
      this.scores[localId] = 0;
      this.healthMap[localId] = 100;
    }

    this._onProjectileHit = (e) => {
      const { shooterSessionId, victimSessionId, damage } = e.detail;

      if (this.deadPlayers.has(victimSessionId)) return;

      const now = Date.now();
      if (this.invincibleUntil[victimSessionId] && now < this.invincibleUntil[victimSessionId]) {
        return;
      }

      if (!(victimSessionId in this.healthMap)) {
        this.healthMap[victimSessionId] = 100;
      }

      let newHealth = Math.max(0, this.healthMap[victimSessionId] - damage);
      this.healthMap[victimSessionId] = newHealth;

      ctx.eventBus.dispatchEvent(new CustomEvent('event:playerDamaged', {
        detail: { sessionId: victimSessionId, newHealth, attackerSessionId: shooterSessionId }
      }));

      ctx.modules.network.send('hit', { victimSessionId, damage });

      if (newHealth <= 0) {
        this.deadPlayers.add(victimSessionId);

        ctx.eventBus.dispatchEvent(new CustomEvent('event:playerKilled', {
          detail: { victimSessionId, killerSessionId: shooterSessionId }
        }));

        if (!(shooterSessionId in this.scores)) {
          this.scores[shooterSessionId] = 0;
        }
        this.scores[shooterSessionId] += 1;

        ctx.eventBus.dispatchEvent(new CustomEvent('event:scoreUpdated', {
          detail: { scores: { ...this.scores } }
        }));

        setTimeout(() => {
          this.deadPlayers.delete(victimSessionId);
          this.healthMap[victimSessionId] = 100;
          this.invincibleUntil[victimSessionId] = Date.now() + 1500;
          ctx.modules.player.respawn(victimSessionId);
        }, 2000);
      }
    };
    ctx.eventBus.addEventListener('event:projectileHit', this._onProjectileHit);

    ctx.modules.network.onMessage('playerHit', (payload) => {
      const { victimSessionId, attackerSessionId, newHealth } = payload;
      this.healthMap[victimSessionId] = newHealth;

      ctx.eventBus.dispatchEvent(new CustomEvent('event:playerDamaged', {
        detail: { sessionId: victimSessionId, newHealth, attackerSessionId }
      }));
    });

    ctx.modules.network.onMessage('playerDied', (payload) => {
      const { victimSessionId, killerSessionId } = payload;
      this.healthMap[victimSessionId] = 0;
      this.deadPlayers.add(victimSessionId);

      ctx.eventBus.dispatchEvent(new CustomEvent('event:playerKilled', {
        detail: { victimSessionId, killerSessionId }
      }));

      setTimeout(() => {
        this.deadPlayers.delete(victimSessionId);
        this.healthMap[victimSessionId] = 100;
        this.invincibleUntil[victimSessionId] = Date.now() + 1500;
      }, 2000);
    });

    ctx.modules.network.onMessage('scoreUpdate', (payload) => {
      const { scores } = payload;
      this.scores = { ...scores };

      ctx.eventBus.dispatchEvent(new CustomEvent('event:scoreUpdated', {
        detail: { scores: { ...this.scores } }
      }));
    });

    ctx.modules.network.onMessage('playerJoined', (payload) => {
      const { sessionId } = payload;
      if (!(sessionId in this.scores)) {
        this.scores[sessionId] = 0;
        this.healthMap[sessionId] = 100;
      }
    });

    ctx.modules.network.onMessage('playerLeave', (payload) => {
      const { sessionId } = payload;
      delete this.scores[sessionId];
      delete this.healthMap[sessionId];
      this.deadPlayers.delete(sessionId);
      delete this.invincibleUntil[sessionId];
    });
  }

  start() {}

  update(dt) {}

  dispose() {
    if (this._onProjectileHit) {
      this.ctx.eventBus.removeEventListener('event:projectileHit', this._onProjectileHit);
    }
  }
}
