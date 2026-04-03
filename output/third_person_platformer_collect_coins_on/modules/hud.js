export default class Hud {
  name = 'hud';

  async build(ctx) {
    this.ctx = ctx;
    this.overlay = ctx.uiOverlay;
    this.listeners = [];
    this.floatingAnims = [];
    this.respawnTimeout = null;

    // --- Coin Counter (top-right) ---
    this.coinContainer = document.createElement('div');
    Object.assign(this.coinContainer.style, {
      position: 'absolute', top: '20px', right: '20px',
      display: 'flex', alignItems: 'center', gap: '8px',
      background: 'rgba(0,0,0,0.5)', borderRadius: '12px',
      padding: '8px 16px', pointerEvents: 'none',
      fontFamily: "'Segoe UI', Arial, sans-serif",
      fontSize: '22px', fontWeight: 'bold', color: '#FFD700',
      textShadow: '0 2px 4px rgba(0,0,0,0.7)',
      transition: 'transform 0.2s ease'
    });
    const coinIcon = document.createElement('span');
    coinIcon.textContent = '🪙';
    coinIcon.style.fontSize = '26px';
    this.coinText = document.createElement('span');
    this.coinText.textContent = 'Coins: 0 / 30';
    this.coinContainer.appendChild(coinIcon);
    this.coinContainer.appendChild(this.coinText);
    this.overlay.appendChild(this.coinContainer);

    // --- Player Score List (top-left) ---
    this.scorePanel = document.createElement('div');
    Object.assign(this.scorePanel.style, {
      position: 'absolute', top: '20px', left: '20px',
      background: 'rgba(0,0,0,0.5)', borderRadius: '12px',
      padding: '10px 16px', pointerEvents: 'none',
      fontFamily: "'Segoe UI', Arial, sans-serif",
      fontSize: '16px', color: '#fff', minWidth: '140px',
      textShadow: '0 1px 3px rgba(0,0,0,0.8)',
      transition: 'opacity 0.3s ease'
    });
    const scoreTitle = document.createElement('div');
    scoreTitle.textContent = 'Players';
    Object.assign(scoreTitle.style, {
      fontWeight: 'bold', fontSize: '14px', color: '#aaa',
      marginBottom: '6px', textTransform: 'uppercase',
      letterSpacing: '1px'
    });
    this.scoreList = document.createElement('div');
    this.scorePanel.appendChild(scoreTitle);
    this.scorePanel.appendChild(this.scoreList);
    this.overlay.appendChild(this.scorePanel);

    // --- Center Notification Area ---
    this.notification = document.createElement('div');
    Object.assign(this.notification.style, {
      position: 'absolute', top: '40%', left: '50%',
      transform: 'translate(-50%, -50%)',
      fontFamily: "'Segoe UI', Arial, sans-serif",
      fontSize: '28px', fontWeight: 'bold', color: '#fff',
      textShadow: '0 2px 8px rgba(0,0,0,0.8)',
      textAlign: 'center', pointerEvents: 'none',
      opacity: '0', transition: 'opacity 0.4s ease',
      whiteSpace: 'nowrap'
    });
    this.overlay.appendChild(this.notification);

    // --- Victory Banner (hidden) ---
    this.victoryBanner = document.createElement('div');
    Object.assign(this.victoryBanner.style, {
      position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
      display: 'none', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', pointerEvents: 'none',
      background: 'rgba(0,0,0,0.6)',
      fontFamily: "'Segoe UI', Arial, sans-serif",
      textAlign: 'center'
    });
    this.victoryText = document.createElement('div');
    Object.assign(this.victoryText.style, {
      fontSize: '56px', fontWeight: 'bold', color: '#FFD700',
      textShadow: '0 0 20px rgba(255,215,0,0.6), 0 4px 8px rgba(0,0,0,0.8)',
      transform: 'scale(0)', transition: 'transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)'
    });
    this.victoryBanner.appendChild(this.victoryText);
    this.overlay.appendChild(this.victoryBanner);

    // --- Respawn Message ---
    this.respawnMsg = document.createElement('div');
    Object.assign(this.respawnMsg.style, {
      position: 'absolute', bottom: '30%', left: '50%',
      transform: 'translateX(-50%)',
      fontFamily: "'Segoe UI', Arial, sans-serif",
      fontSize: '32px', fontWeight: 'bold', color: '#FF5722',
      textShadow: '0 2px 8px rgba(0,0,0,0.8)',
      pointerEvents: 'none', opacity: '0',
      transition: 'opacity 0.3s ease'
    });
    this.respawnMsg.textContent = 'Respawning...';
    this.overlay.appendChild(this.respawnMsg);

    // --- CSS Keyframes for floating +1 ---
    if (!document.getElementById('hud-keyframes')) {
      const style = document.createElement('style');
      style.id = 'hud-keyframes';
      style.textContent = `
        @keyframes hud-float-up {
          0% { opacity: 1; transform: translateY(0) scale(1); }
          100% { opacity: 0; transform: translateY(-40px) scale(1.3); }
        }
      `;
      document.head.appendChild(style);
      this._styleEl = style;
    }

    // Player scores tracking
    this.playerScores = {};
    this.totalCoins = 30;
    this.myScore = 0;

    // --- Event Listeners ---
    const listen = (name, handler) => {
      const bound = handler.bind(this);
      ctx.eventBus.addEventListener(name, bound);
      this.listeners.push({ name, handler: bound });
    };

    listen('event:scoreUpdated', (e) => {
      const { playerId, score, totalCoins } = e.detail;
      this.totalCoins = totalCoins;
      this.playerScores[playerId] = score;

      const localId = this._getLocalId();
      if (playerId === localId) {
        this.myScore = score;
        this.coinText.textContent = `Coins: ${score} / ${totalCoins}`;
        // Pulse animation
        this.coinContainer.style.transform = 'scale(1.15)';
        setTimeout(() => { this.coinContainer.style.transform = 'scale(1)'; }, 200);
      }

      this._updateScoreList();
    });

    listen('event:coinCollected', (e) => {
      const { playerId } = e.detail;
      const localId = this._getLocalId();
      if (playerId === localId) {
        this._spawnFloatingPlus();
      }
    });

    listen('event:allCoinsCollected', (e) => {
      const { winnerId } = e.detail;
      const localId = this._getLocalId();
      if (winnerId === localId) {
        this.victoryText.textContent = '🏆 You Win! 🏆';
      } else {
        this.victoryText.textContent = `${winnerId.substring(0, 6)}... collected all coins!`;
      }
      this.victoryBanner.style.display = 'flex';
      requestAnimationFrame(() => {
        this.victoryText.style.transform = 'scale(1)';
      });
    });

    listen('event:playerFell', (e) => {
      const { playerId } = e.detail;
      const localId = this._getLocalId();
      if (playerId === localId) {
        this.respawnMsg.style.opacity = '1';
      }
    });

    listen('event:playerRespawn', (e) => {
      const { playerId } = e.detail;
      const localId = this._getLocalId();
      if (playerId === localId) {
        this.respawnMsg.style.opacity = '0';
      }
    });
  }

  _getLocalId() {
    try {
      return this.ctx.modules.network?.getSessionId() || 'local';
    } catch {
      return 'local';
    }
  }

  _updateScoreList() {
    const localId = this._getLocalId();
    const entries = Object.entries(this.playerScores)
      .sort((a, b) => b[1] - a[1]);

    this.scoreList.innerHTML = '';
    const colors = ['#FF5722', '#2196F3', '#9C27B0', '#FFEB3B'];

    entries.forEach(([id, score], i) => {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex', justifyContent: 'space-between',
        padding: '2px 0', gap: '12px'
      });
      const name = document.createElement('span');
      const isLocal = id === localId;
      name.textContent = isLocal ? 'You' : `P${i + 1}`;
      name.style.color = colors[i % colors.length];
      if (isLocal) name.style.fontWeight = 'bold';

      const val = document.createElement('span');
      val.textContent = score;
      val.style.color = '#FFD700';

      row.appendChild(name);
      row.appendChild(val);
      this.scoreList.appendChild(row);
    });
  }

  _spawnFloatingPlus() {
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'absolute', top: '20px', right: '140px',
      fontSize: '24px', fontWeight: 'bold', color: '#FFD700',
      textShadow: '0 1px 4px rgba(0,0,0,0.7)',
      pointerEvents: 'none',
      animation: 'hud-float-up 0.8s ease-out forwards'
    });
    el.textContent = '+1';
    this.overlay.appendChild(el);
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 850);
  }

  _showNotification(text, duration = 2000) {
    this.notification.textContent = text;
    this.notification.style.opacity = '1';
    if (this._notifTimeout) clearTimeout(this._notifTimeout);
    this._notifTimeout = setTimeout(() => {
      this.notification.style.opacity = '0';
    }, duration);
  }

  start() {}

  update(dt) {}

  dispose() {
    // Remove event listeners
    for (const { name, handler } of this.listeners) {
      this.ctx.eventBus.removeEventListener(name, handler);
    }
    this.listeners = [];

    // Remove DOM elements
    const elements = [
      this.coinContainer, this.scorePanel, this.notification,
      this.victoryBanner, this.respawnMsg
    ];
    for (const el of elements) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    // Remove injected style
    if (this._styleEl && this._styleEl.parentNode) {
      this._styleEl.parentNode.removeChild(this._styleEl);
    }

    if (this._notifTimeout) clearTimeout(this._notifTimeout);
  }
}
