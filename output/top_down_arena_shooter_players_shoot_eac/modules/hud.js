export default class HUD {
  name = 'hud';

  async build(ctx) {
    this.ctx = ctx;
    this.overlay = ctx.uiOverlay;
    this.killFeedEntries = [];
    this.scores = {};
    this.deathOverlayTimeout = null;

    // --- Health Bar (bottom-center) ---
    this.healthBarContainer = document.createElement('div');
    Object.assign(this.healthBarContainer.style, {
      position: 'absolute', bottom: '40px', left: '50%', transform: 'translateX(-50%)',
      width: '250px', height: '20px', background: 'rgba(0,0,0,0.7)',
      border: '2px solid rgba(255,255,255,0.3)', borderRadius: '4px',
      overflow: 'hidden', pointerEvents: 'none'
    });
    this.healthBarFill = document.createElement('div');
    Object.assign(this.healthBarFill.style, {
      width: '100%', height: '100%', background: '#00ff00',
      transition: 'width 0.3s ease, background-color 0.3s ease'
    });
    this.healthBarContainer.appendChild(this.healthBarFill);
    this.overlay.appendChild(this.healthBarContainer);

    // Health text
    this.healthText = document.createElement('div');
    Object.assign(this.healthText.style, {
      position: 'absolute', bottom: '42px', left: '50%', transform: 'translateX(-50%)',
      width: '250px', textAlign: 'center', color: '#fff', fontSize: '12px',
      fontFamily: 'monospace', pointerEvents: 'none', lineHeight: '20px',
      textShadow: '1px 1px 2px #000'
    });
    this.healthText.textContent = '100';
    this.overlay.appendChild(this.healthText);

    // --- Scoreboard (top-right) ---
    this.scoreboard = document.createElement('div');
    Object.assign(this.scoreboard.style, {
      position: 'absolute', top: '10px', right: '10px',
      background: 'rgba(0,0,0,0.7)', padding: '10px 14px', borderRadius: '6px',
      color: '#fff', fontFamily: 'monospace', fontSize: '13px',
      minWidth: '140px', pointerEvents: 'none'
    });
    this.scoreTitle = document.createElement('div');
    Object.assign(this.scoreTitle.style, {
      borderBottom: '1px solid rgba(255,255,255,0.3)', paddingBottom: '4px',
      marginBottom: '6px', fontWeight: 'bold', fontSize: '14px'
    });
    this.scoreTitle.textContent = 'SCOREBOARD';
    this.scoreboard.appendChild(this.scoreTitle);
    this.scoreList = document.createElement('div');
    this.scoreboard.appendChild(this.scoreList);
    this.overlay.appendChild(this.scoreboard);

    // --- Crosshair (center) ---
    this.crosshair = document.createElement('div');
    Object.assign(this.crosshair.style, {
      position: 'absolute', top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)', pointerEvents: 'none'
    });
    // Horizontal line
    const hLine = document.createElement('div');
    Object.assign(hLine.style, {
      position: 'absolute', top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '20px', height: '2px', background: 'rgba(255,255,255,0.8)'
    });
    // Vertical line
    const vLine = document.createElement('div');
    Object.assign(vLine.style, {
      position: 'absolute', top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '2px', height: '20px', background: 'rgba(255,255,255,0.8)'
    });
    // Center dot
    const dot = document.createElement('div');
    Object.assign(dot.style, {
      position: 'absolute', top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '4px', height: '4px', borderRadius: '50%', background: '#ff4444'
    });
    this.crosshair.appendChild(hLine);
    this.crosshair.appendChild(vLine);
    this.crosshair.appendChild(dot);
    this.overlay.appendChild(this.crosshair);

    // --- Kill Feed (top-left) ---
    this.killFeed = document.createElement('div');
    Object.assign(this.killFeed.style, {
      position: 'absolute', top: '10px', left: '10px',
      pointerEvents: 'none', fontFamily: 'monospace', fontSize: '13px'
    });
    this.overlay.appendChild(this.killFeed);

    // --- Damage Flash (screen edge red flash) ---
    this.damageFlash = document.createElement('div');
    Object.assign(this.damageFlash.style, {
      position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
      pointerEvents: 'none', opacity: '0',
      boxShadow: 'inset 0 0 80px 20px rgba(255,0,0,0.6)',
      transition: 'opacity 0.1s ease-in'
    });
    this.overlay.appendChild(this.damageFlash);

    // --- Death / Kill overlay (center) ---
    this.centerOverlay = document.createElement('div');
    Object.assign(this.centerOverlay.style, {
      position: 'absolute', top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      pointerEvents: 'none', fontFamily: 'monospace', fontSize: '48px',
      fontWeight: 'bold', textShadow: '2px 2px 8px #000',
      opacity: '0', transition: 'opacity 0.3s ease', textAlign: 'center'
    });
    this.overlay.appendChild(this.centerOverlay);

    // Player colors from visual spec
    this.playerColors = ['#00ffff', '#ff00ff', '#ffff00', '#00ff00'];
    this.playerColorMap = {};
    this.colorIndex = 0;

    // --- Event listeners ---
    this._onPlayerDamaged = (e) => this._handlePlayerDamaged(e.detail);
    this._onPlayerKilled = (e) => this._handlePlayerKilled(e.detail);
    this._onScoreUpdated = (e) => this._handleScoreUpdated(e.detail);
    this._onPlayerRespawned = (e) => this._handlePlayerRespawned(e.detail);

    ctx.eventBus.addEventListener('event:playerDamaged', this._onPlayerDamaged);
    ctx.eventBus.addEventListener('event:playerKilled', this._onPlayerKilled);
    ctx.eventBus.addEventListener('event:scoreUpdated', this._onScoreUpdated);
    ctx.eventBus.addEventListener('event:playerRespawned', this._onPlayerRespawned);
  }

  start() {}

  _getSessionId() {
    try {
      return this.ctx.modules.network && this.ctx.modules.network.getSessionId
        ? this.ctx.modules.network.getSessionId()
        : null;
    } catch (e) {
      return null;
    }
  }

  _getPlayerColor(sessionId) {
    if (!this.playerColorMap[sessionId]) {
      this.playerColorMap[sessionId] = this.playerColors[this.colorIndex % this.playerColors.length];
      this.colorIndex++;
    }
    return this.playerColorMap[sessionId];
  }

  _getHealthColor(health) {
    if (health > 60) return '#00ff00';
    if (health > 30) return '#ffff00';
    return '#ff4444';
  }

  _updateHealthBar(health) {
    const h = Math.max(0, Math.min(100, health));
    this.healthBarFill.style.width = h + '%';
    this.healthBarFill.style.backgroundColor = this._getHealthColor(h);
    this.healthText.textContent = Math.round(h);
  }

  _handlePlayerDamaged(detail) {
    const { sessionId, newHealth } = detail;
    const localId = this._getSessionId();

    if (sessionId === localId) {
      this._updateHealthBar(newHealth);
      // Flash screen edges red
      this.damageFlash.style.opacity = '1';
      setTimeout(() => { this.damageFlash.style.opacity = '0'; }, 200);
      // Animate health bar with a brief scale pulse
      this.healthBarContainer.style.transform = 'translateX(-50%) scaleY(1.3)';
      setTimeout(() => {
        this.healthBarContainer.style.transform = 'translateX(-50%) scaleY(1)';
      }, 150);
    }
  }

  _handlePlayerKilled(detail) {
    const { victimSessionId, killerSessionId } = detail;
    const localId = this._getSessionId();

    // Shorten IDs for display
    const victimName = victimSessionId ? victimSessionId.substring(0, 6) : '???';
    const killerName = killerSessionId ? killerSessionId.substring(0, 6) : '???';

    // Add kill feed entry
    this._addKillFeedEntry(killerName, victimName, killerSessionId, victimSessionId);

    // Show center overlay
    if (victimSessionId === localId) {
      this._showCenterOverlay('YOU DIED', '#ff4444', 2000);
      this._updateHealthBar(0);
    } else if (killerSessionId === localId) {
      this._showCenterOverlay('+1 KILL', '#00ff00', 2000);
    }
  }

  _addKillFeedEntry(killerName, victimName, killerSessionId, victimSessionId) {
    const entry = document.createElement('div');
    Object.assign(entry.style, {
      color: '#fff', padding: '3px 8px', marginBottom: '2px',
      background: 'rgba(0,0,0,0.5)', borderRadius: '3px',
      transition: 'opacity 0.5s ease', opacity: '1', whiteSpace: 'nowrap'
    });

    const killerColor = this._getPlayerColor(killerSessionId);
    const victimColor = this._getPlayerColor(victimSessionId);

    entry.innerHTML =
      `<span style="color:${killerColor};font-weight:bold">${killerName}</span>` +
      ` <span style="color:#aaa">killed</span> ` +
      `<span style="color:${victimColor};font-weight:bold">${victimName}</span>`;

    this.killFeed.appendChild(entry);
    this.killFeedEntries.push(entry);

    // Fade out after 3 seconds
    setTimeout(() => {
      entry.style.opacity = '0';
      setTimeout(() => {
        if (entry.parentNode) entry.parentNode.removeChild(entry);
        const idx = this.killFeedEntries.indexOf(entry);
        if (idx !== -1) this.killFeedEntries.splice(idx, 1);
      }, 500);
    }, 3000);

    // Keep max 5 entries visible
    while (this.killFeedEntries.length > 5) {
      const old = this.killFeedEntries.shift();
      if (old.parentNode) old.parentNode.removeChild(old);
    }
  }

  _showCenterOverlay(text, color, durationMs) {
    if (this.deathOverlayTimeout) clearTimeout(this.deathOverlayTimeout);
    this.centerOverlay.textContent = text;
    this.centerOverlay.style.color = color;
    this.centerOverlay.style.opacity = '1';
    this.deathOverlayTimeout = setTimeout(() => {
      this.centerOverlay.style.opacity = '0';
      this.deathOverlayTimeout = null;
    }, durationMs);
  }

  _handleScoreUpdated(detail) {
    this.scores = detail.scores || {};
    this._renderScoreboard();
  }

  _handlePlayerRespawned(detail) {
    const localId = this._getSessionId();
    if (detail.sessionId === localId) {
      // Clear death overlay
      if (this.deathOverlayTimeout) clearTimeout(this.deathOverlayTimeout);
      this.centerOverlay.style.opacity = '0';
      this.deathOverlayTimeout = null;
      // Reset health bar
      this._updateHealthBar(100);
    }
  }

  _renderScoreboard() {
    this.scoreList.innerHTML = '';
    const sorted = Object.entries(this.scores).sort((a, b) => b[1] - a[1]);
    const localId = this._getSessionId();

    for (const [sessionId, score] of sorted) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '2px 0', opacity: '0.9'
      });

      const colorDot = document.createElement('span');
      Object.assign(colorDot.style, {
        display: 'inline-block', width: '10px', height: '10px',
        borderRadius: '50%', background: this._getPlayerColor(sessionId),
        flexShrink: '0'
      });

      const nameSpan = document.createElement('span');
      nameSpan.style.flex = '1';
      const displayName = sessionId.substring(0, 6);
      nameSpan.textContent = displayName;
      if (sessionId === localId) {
        nameSpan.style.fontWeight = 'bold';
        nameSpan.textContent = displayName + ' (you)';
      }

      const scoreSpan = document.createElement('span');
      scoreSpan.style.fontWeight = 'bold';
      scoreSpan.textContent = score;

      row.appendChild(colorDot);
      row.appendChild(nameSpan);
      row.appendChild(scoreSpan);
      this.scoreList.appendChild(row);
    }
  }

  update(dt) {
    // Periodically sync health from player module if available
    const localId = this._getSessionId();
    if (localId && this.ctx.modules.player && this.ctx.modules.player.getHealth) {
      const health = this.ctx.modules.player.getHealth(localId);
      if (health !== undefined) {
        this._updateHealthBar(health);
      }
    }
  }

  dispose() {
    this.ctx.eventBus.removeEventListener('event:playerDamaged', this._onPlayerDamaged);
    this.ctx.eventBus.removeEventListener('event:playerKilled', this._onPlayerKilled);
    this.ctx.eventBus.removeEventListener('event:scoreUpdated', this._onScoreUpdated);
    this.ctx.eventBus.removeEventListener('event:playerRespawned', this._onPlayerRespawned);

    if (this.deathOverlayTimeout) clearTimeout(this.deathOverlayTimeout);

    [this.healthBarContainer, this.healthText, this.scoreboard, this.crosshair,
     this.killFeed, this.damageFlash, this.centerOverlay].forEach(el => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  }
}
