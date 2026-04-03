export default class Player {
  name = 'player';

  async build(ctx) {
    this.ctx = ctx;
    this.scene = ctx.scene;
    this.camera = ctx.camera;
    this.config = ctx.gameConfig;

    // Player data: Map<sessionId, { mesh, x, y, z, rotation, health, score, colorIndex }>
    this.players = new Map();
    this.localSessionId = null;
    this.keys = { w: false, a: false, s: false, d: false, up: false, down: false, left: false, right: false };
    this.mouseX = 0;
    this.mouseZ = 0;
    this.lastFireTime = 0;
    this.fireCooldown = 250;
    this.speed = 8;
    this.syncInterval = 1000 / 20; // 20 Hz
    this.lastSyncTime = 0;
    this.colorIndex = 0;
    this.dead = false;
    this.invincibleUntil = 0;

    const playerColors = ['#00ffff', '#ff00ff', '#ffff00', '#00ff00'];
    this.playerColors = playerColors;

    const spawnPoints = [
      { x: -12, z: -12 },
      { x: 12, z: -12 },
      { x: -12, z: 12 },
      { x: 12, z: 12 }
    ];
    this.spawnPoints = spawnPoints;

    // Build template mesh: cylinder body + cone nose
    const bodyGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.8, 12);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 0.3 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);

    const noseGeo = new THREE.ConeGeometry(0.2, 0.5, 8);
    const noseMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5 });
    const nose = new THREE.Mesh(noseGeo, noseMat);
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = 0.6;

    const template = new THREE.Group();
    template.add(body);
    template.add(nose);
    ctx.meshRegistry.set('player_mesh', template);

    // Input handlers
    this._onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'arrowup') this.keys.w = true;
      if (k === 'a' || k === 'arrowleft') this.keys.a = true;
      if (k === 's' || k === 'arrowdown') this.keys.s = true;
      if (k === 'd' || k === 'arrowright') this.keys.d = true;
    };
    this._onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'arrowup') this.keys.w = false;
      if (k === 'a' || k === 'arrowleft') this.keys.a = false;
      if (k === 's' || k === 'arrowdown') this.keys.s = false;
      if (k === 'd' || k === 'arrowright') this.keys.d = false;
    };
    this._onMouseMove = (e) => {
      // Convert screen mouse to world XZ using raycasting onto Y=0 plane
      const rect = ctx.camera.domElement || document.querySelector('canvas');
      if (!rect) return;
      const bounds = (rect.getBoundingClientRect ? rect : document.querySelector('canvas')).getBoundingClientRect();
      const ndcX = ((e.clientX - bounds.left) / bounds.width) * 2 - 1;
      const ndcY = -((e.clientY - bounds.top) / bounds.height) * 2 + 1;

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), ctx.camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const target = new THREE.Vector3();
      raycaster.ray.intersectPlane(plane, target);
      if (target) {
        this.mouseX = target.x;
        this.mouseZ = target.z;
      }
    };
    this._onMouseDown = (e) => {
      if (e.button === 0) this._tryShoot();
    };
    this._onKeyShoot = (e) => {
      if (e.code === 'Space') this._tryShoot();
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('keydown', this._onKeyShoot);

    // Listen for playerDamaged event
    this._onPlayerDamaged = (e) => {
      const { sessionId, newHealth } = e.detail;
      const p = this.players.get(sessionId);
      if (p) p.health = newHealth;
    };
    ctx.eventBus.addEventListener('event:playerDamaged', this._onPlayerDamaged);

    // Listen for playerKilled event
    this._onPlayerKilled = (e) => {
      const { victimSessionId } = e.detail;
      if (victimSessionId === this.localSessionId) {
        this.dead = true;
        const p = this.players.get(victimSessionId);
        if (p && p.mesh) p.mesh.visible = false;
        // Respawn after delay
        setTimeout(() => {
          this.respawn(victimSessionId);
        }, 2000);
      } else {
        const p = this.players.get(victimSessionId);
        if (p && p.mesh) p.mesh.visible = false;
        setTimeout(() => {
          if (this.players.has(victimSessionId)) {
            this.respawn(victimSessionId);
          }
        }, 2000);
      }
    };
    ctx.eventBus.addEventListener('event:playerKilled', this._onPlayerKilled);

    // Register network listeners after network is available
    this._setupNetwork();
  }

  _setupNetwork() {
    const ctx = this.ctx;
    const trySetup = () => {
      const net = ctx.modules.network;
      if (!net) {
        setTimeout(trySetup, 100);
        return;
      }

      this.localSessionId = net.getSessionId();

      net.onMessage('gameState', (data) => {
        if (!data.players) return;
        for (const [sid, pdata] of Object.entries(data.players)) {
          if (!this.players.has(sid)) {
            this._addPlayer(sid, pdata.x || 0, pdata.z || 0);
          }
          const p = this.players.get(sid);
          if (p) {
            p.x = pdata.x || 0;
            p.z = pdata.z || 0;
            p.rotation = pdata.rotation || 0;
            p.health = pdata.health !== undefined ? pdata.health : 100;
            p.score = pdata.score || 0;
          }
        }
        // If we don't have localSessionId yet, try again
        if (!this.localSessionId) {
          this.localSessionId = net.getSessionId();
        }
      });

      net.onMessage('playerJoined', (data) => {
        if (!this.players.has(data.sessionId)) {
          this._addPlayer(data.sessionId, data.x || 0, data.z || 0);
        }
      });

      net.onMessage('playerLeave', (data) => {
        this._removePlayer(data.sessionId);
      });

      net.onMessage('playerMoved', (data) => {
        if (data.sessionId === this.localSessionId) return;
        const p = this.players.get(data.sessionId);
        if (p) {
          p.x = data.x;
          p.z = data.z;
          p.rotation = data.rotation;
        }
      });

      net.onMessage('playerShot', (data) => {
        if (data.sessionId === this.localSessionId) return;
        // Emit playerShoot event for projectile module
        this.ctx.eventBus.dispatchEvent(new CustomEvent('event:playerShoot', {
          detail: {
            sessionId: data.sessionId,
            originX: data.originX,
            originZ: data.originZ,
            dirX: data.dirX,
            dirZ: data.dirZ
          }
        }));
      });

      net.onMessage('playerHit', (data) => {
        const p = this.players.get(data.victimSessionId);
        if (p) p.health = data.newHealth;
      });

      net.onMessage('playerDied', (data) => {
        // playerKilled event is handled by combat module, but we hide mesh
        const p = this.players.get(data.victimSessionId);
        if (p && p.mesh) p.mesh.visible = false;
      });

      net.onMessage('scoreUpdate', (data) => {
        if (!data.scores) return;
        for (const [sid, score] of Object.entries(data.scores)) {
          const p = this.players.get(sid);
          if (p) p.score = score;
        }
      });

      // Spawn local player if not yet added
      if (this.localSessionId && !this.players.has(this.localSessionId)) {
        const sp = this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)];
        this._addPlayer(this.localSessionId, sp.x, sp.z);
      }
    };
    trySetup();
  }

  _addPlayer(sessionId, x, z) {
    if (this.players.has(sessionId)) return;

    const ci = this.colorIndex % this.playerColors.length;
    this.colorIndex++;
    const color = new THREE.Color(this.playerColors[ci]);

    // Clone template
    const template = this.ctx.meshRegistry.get('player_mesh');
    const mesh = template.clone(true);

    // Set color on body (first child)
    mesh.children[0].material = mesh.children[0].material.clone();
    mesh.children[0].material.color.set(color);
    mesh.children[0].material.emissive.set(color);
    mesh.children[0].material.emissiveIntensity = 0.3;

    const terrainY = this.ctx.getTerrainHeight ? this.ctx.getTerrainHeight(x, z) : 0;
    mesh.position.set(x, terrainY + 0.4, z);
    this.scene.add(mesh);

    this.players.set(sessionId, {
      mesh,
      x,
      y: terrainY + 0.4,
      z,
      rotation: 0,
      health: 100,
      score: 0,
      colorIndex: ci
    });
  }

  _removePlayer(sessionId) {
    const p = this.players.get(sessionId);
    if (p) {
      this.scene.remove(p.mesh);
      this.players.delete(sessionId);
    }
  }

  _tryShoot() {
    if (this.dead) return;
    const now = performance.now();
    if (now - this.lastFireTime < this.fireCooldown) return;
    this.lastFireTime = now;

    const p = this.players.get(this.localSessionId);
    if (!p) return;

    const dirX = Math.sin(p.rotation);
    const dirZ = Math.cos(p.rotation);

    // Emit local event
    this.ctx.eventBus.dispatchEvent(new CustomEvent('event:playerShoot', {
      detail: {
        sessionId: this.localSessionId,
        originX: p.x,
        originZ: p.z,
        dirX,
        dirZ
      }
    }));

    // Send to network
    const net = this.ctx.modules.network;
    if (net) {
      net.send('playerShoot', {
        originX: p.x,
        originZ: p.z,
        dirX,
        dirZ
      });
    }
  }

  start() {
    // Ensure local player exists
    if (this.localSessionId && !this.players.has(this.localSessionId)) {
      const sp = this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)];
      this._addPlayer(this.localSessionId, sp.x, sp.z);
    }
  }

  update(dt) {
    if (!this.localSessionId) {
      const net = this.ctx.modules.network;
      if (net) this.localSessionId = net.getSessionId();
      if (!this.localSessionId) return;
      if (!this.players.has(this.localSessionId)) {
        const sp = this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)];
        this._addPlayer(this.localSessionId, sp.x, sp.z);
      }
    }

    const p = this.players.get(this.localSessionId);
    if (!p) return;

    // Movement
    if (!this.dead) {
      let dx = 0, dz = 0;
      if (this.keys.w) dz -= 1;
      if (this.keys.s) dz += 1;
      if (this.keys.a) dx -= 1;
      if (this.keys.d) dx += 1;

      if (dx !== 0 || dz !== 0) {
        const len = Math.sqrt(dx * dx + dz * dz);
        dx /= len;
        dz /= len;
        p.x += dx * this.speed * dt;
        p.z += dz * this.speed * dt;

        // Clamp to arena bounds
        const half = 15; // arena is 30x30
        p.x = Math.max(-half + 0.5, Math.min(half - 0.5, p.x));
        p.z = Math.max(-half + 0.5, Math.min(half - 0.5, p.z));
      }

      // Rotation: face mouse cursor
      const angle = Math.atan2(this.mouseX - p.x, this.mouseZ - p.z);
      p.rotation = angle;
    }

    // Update local mesh
    const terrainY = this.ctx.getTerrainHeight ? this.ctx.getTerrainHeight(p.x, p.z) : 0;
    p.y = terrainY + 0.4;
    p.mesh.position.set(p.x, p.y, p.z);
    p.mesh.rotation.y = p.rotation;

    // Sync to network
    const now = performance.now();
    if (!this.dead && now - this.lastSyncTime > this.syncInterval) {
      this.lastSyncTime = now;
      const net = this.ctx.modules.network;
      if (net) {
        net.send('playerMove', { x: p.x, z: p.z, rotation: p.rotation });
      }
    }

    // Update remote player meshes
    for (const [sid, rp] of this.players) {
      if (sid === this.localSessionId) continue;
      const ry = this.ctx.getTerrainHeight ? this.ctx.getTerrainHeight(rp.x, rp.z) : 0;
      rp.mesh.position.set(rp.x, ry + 0.4, rp.z);
      rp.mesh.rotation.y = rp.rotation;
    }

    // Camera follow (top-down)
    this.ctx.camera.position.set(p.x, 25, p.z + 0.01);
    this.ctx.camera.lookAt(p.x, 0, p.z);
  }

  // === Public API (ctx.modules.player) ===

  getPosition(sessionId) {
    const sid = sessionId || this.localSessionId;
    const p = this.players.get(sid);
    if (!p) return null;
    return { x: p.x, y: p.y || 0, z: p.z };
  }

  getHealth(sessionId) {
    const sid = sessionId || this.localSessionId;
    const p = this.players.get(sid);
    if (!p) return 0;
    return p.health;
  }

  getAllPlayers() {
    const result = new Map();
    for (const [sid, p] of this.players) {
      result.set(sid, { x: p.x, y: p.y || 0, z: p.z, rotation: p.rotation });
    }
    return result;
  }

  respawn(sessionId) {
    const p = this.players.get(sessionId);
    if (!p) return;

    const sp = this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)];
    p.x = sp.x;
    p.z = sp.z;
    p.health = 100;
    p.mesh.visible = true;

    if (sessionId === this.localSessionId) {
      this.dead = false;
      this.invincibleUntil = performance.now() + 1500;
    }

    this.ctx.eventBus.dispatchEvent(new CustomEvent('event:playerRespawned', {
      detail: { sessionId, x: sp.x, z: sp.z }
    }));
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('keydown', this._onKeyShoot);
    this.ctx.eventBus.removeEventListener('event:playerDamaged', this._onPlayerDamaged);
    this.ctx.eventBus.removeEventListener('event:playerKilled', this._onPlayerKilled);

    for (const [sid, p] of this.players) {
      this.scene.remove(p.mesh);
    }
    this.players.clear();
  }
}
