export default class Collectibles {
  name = 'collectibles';

  async build(ctx) {
    this.ctx = ctx;
    this.coins = [];
    this.score = 0;
    this.totalCoins = 30;
    this.startTime = Date.now();
    this.coinMeshes = [];
    this.coinBodies = [];
    this.coinColliders = [];
    this.elapsedTime = 0;

    // Create gold coin template mesh (flat disc)
    const coinGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.08, 24);
    const coinMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#FFD700'),
      emissive: new THREE.Color('#FFA000'),
      emissiveIntensity: 0.4,
      metalness: 0.8,
      roughness: 0.2
    });
    const coinMesh = new THREE.Mesh(coinGeo, coinMat);
    coinMesh.visible = false;
    ctx.scene.add(coinMesh);
    ctx.meshRegistry.set('coin_mesh', coinMesh);

    // Get island positions and distribute coins
    const islands = ctx.getIslandPositions();
    const coinPositions = this._distributeCoinPositions(islands);

    // Create coin instances
    for (let i = 0; i < coinPositions.length; i++) {
      const pos = coinPositions[i];
      const id = `coin_${i}`;

      // Create mesh instance
      const mesh = coinMesh.clone();
      mesh.material = coinMat.clone();
      mesh.visible = true;
      mesh.position.set(pos.x, pos.y, pos.z);
      ctx.scene.add(mesh);
      this.coinMeshes.push(mesh);

      // Create Rapier sensor collider (no rigid body response)
      const bodyDesc = ctx.RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(pos.x, pos.y, pos.z);
      const body = ctx.rapierWorld.createRigidBody(bodyDesc);

      const colliderDesc = ctx.RAPIER.ColliderDesc.cylinder(0.3, 0.5)
        .setSensor(true);
      const collider = ctx.rapierWorld.createCollider(colliderDesc, body);

      this.coinBodies.push(body);
      this.coinColliders.push(collider);

      // Track coin state
      this.coins.push({
        id,
        position: { x: pos.x, y: pos.y, z: pos.z },
        baseY: pos.y,
        collected: false,
        mesh,
        body,
        collider
      });
    }

    // Listen for server coinCollected messages (other players picking up coins)
    if (ctx.modules.network) {
      this._registerNetworkHandlers();
    } else {
      // Network may not be built yet; listen for it
      const checkNetwork = () => {
        if (ctx.modules.network) {
          this._registerNetworkHandlers();
        } else {
          requestAnimationFrame(checkNetwork);
        }
      };
      checkNetwork();
    }
  }

  _registerNetworkHandlers() {
    const net = this.ctx.modules.network;
    if (!net || this._networkRegistered) return;
    this._networkRegistered = true;

    net.onMessage('coinCollected', (data) => {
      const sessionId = net.getSessionId();
      // Only process if collected by another player
      if (data.playerId !== sessionId) {
        const coin = this.coins.find(c => c.id === data.coinId);
        if (coin && !coin.collected) {
          coin.collected = true;
          coin.mesh.visible = false;

          this.ctx.eventBus.dispatchEvent(new CustomEvent('event:coinCollected', {
            detail: {
              coinId: data.coinId,
              playerId: data.playerId,
              position: coin.position
            }
          }));
        }
      }
    });

    net.onMessage('gameOver', (data) => {
      this.ctx.eventBus.dispatchEvent(new CustomEvent('event:allCoinsCollected', {
        detail: {
          winnerId: data.winnerId,
          finalScore: data.scores[data.winnerId] || 0,
          timeElapsed: data.timeElapsed
        }
      }));
    });
  }

  _distributeCoinPositions(islands) {
    const positions = [];
    if (!islands || islands.length === 0) return positions;

    // Calculate total radius for proportional distribution
    const totalRadius = islands.reduce((sum, isl) => sum + isl.radius, 0);

    // Distribute coins proportionally to island radius, min 2 per island
    let remaining = this.totalCoins;
    const perIsland = [];

    for (let i = 0; i < islands.length; i++) {
      perIsland.push(2); // minimum 2
      remaining -= 2;
    }

    // Distribute remaining proportionally
    for (let i = 0; i < islands.length && remaining > 0; i++) {
      const extra = Math.round((islands[i].radius / totalRadius) * (this.totalCoins - islands.length * 2));
      const toAdd = Math.min(extra, remaining);
      perIsland[i] += toAdd;
      remaining -= toAdd;
    }

    // If any remain, distribute round-robin
    let idx = 0;
    while (remaining > 0) {
      perIsland[idx % islands.length]++;
      remaining--;
      idx++;
    }

    // Place coins on each island
    for (let i = 0; i < islands.length; i++) {
      const island = islands[i];
      const count = perIsland[i];
      const placementRadius = island.radius * 0.7;

      for (let j = 0; j < count; j++) {
        const angle = (j / count) * Math.PI * 2 + i * 0.5; // offset per island
        const dist = placementRadius * (0.3 + 0.7 * ((j + 1) / count));
        const x = island.x + Math.cos(angle) * dist;
        const z = island.z + Math.sin(angle) * dist;
        const terrainY = this.ctx.getTerrainHeight(x, z);
        const y = (terrainY === -Infinity) ? island.y + 1.0 : terrainY + 1.0;

        positions.push({ x, y, z });
      }
    }

    return positions;
  }

  start() {
    this.startTime = Date.now();
  }

  update(dt) {
    if (!this.ctx) return;

    this.elapsedTime += dt;
    const spinSpeed = 2.0;
    const bobAmplitude = 0.3;
    const bobSpeed = 1.5;
    const pickupDistance = 1.8;

    // Get player position for proximity check
    let playerPos = null;
    if (this.ctx.modules.player && this.ctx.modules.player.getPosition) {
      playerPos = this.ctx.modules.player.getPosition();
    }

    for (let i = 0; i < this.coins.length; i++) {
      const coin = this.coins[i];
      if (coin.collected) continue;

      // Spin around Y axis
      coin.mesh.rotation.y += spinSpeed * dt;

      // Bob up and down
      const bobOffset = Math.sin(this.elapsedTime * bobSpeed + i * 0.5) * bobAmplitude;
      coin.mesh.position.y = coin.baseY + bobOffset;

      // Update kinematic body position to match
      coin.body.setNextKinematicTranslation({
        x: coin.mesh.position.x,
        y: coin.mesh.position.y,
        z: coin.mesh.position.z
      });

      // Proximity check for collection
      if (playerPos) {
        const dx = playerPos.x - coin.position.x;
        const dy = playerPos.y - coin.mesh.position.y;
        const dz = playerPos.z - coin.position.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq < pickupDistance * pickupDistance) {
          this._collectCoin(coin);
        }
      }
    }
  }

  _collectCoin(coin) {
    if (coin.collected) return;
    coin.collected = true;
    coin.mesh.visible = false;
    this.score++;

    // Disable sensor collider
    coin.collider.setSensor(false);
    coin.collider.setEnabled(false);

    const playerId = (this.ctx.modules.network && this.ctx.modules.network.getSessionId)
      ? this.ctx.modules.network.getSessionId()
      : 'local';

    // Send to server
    if (this.ctx.modules.network && this.ctx.modules.network.send) {
      this.ctx.modules.network.send('collectCoin', { coinId: coin.id });
    }

    // Dispatch local coinCollected event
    this.ctx.eventBus.dispatchEvent(new CustomEvent('event:coinCollected', {
      detail: {
        coinId: coin.id,
        playerId,
        position: { x: coin.position.x, y: coin.position.y, z: coin.position.z }
      }
    }));

    // Dispatch scoreUpdated event
    this.ctx.eventBus.dispatchEvent(new CustomEvent('event:scoreUpdated', {
      detail: {
        playerId,
        score: this.score,
        totalCoins: this.totalCoins
      }
    }));

    // Check if all coins collected
    if (this.score >= this.totalCoins) {
      const timeElapsed = (Date.now() - this.startTime) / 1000;
      this.ctx.eventBus.dispatchEvent(new CustomEvent('event:allCoinsCollected', {
        detail: {
          winnerId: playerId,
          finalScore: this.score,
          timeElapsed
        }
      }));
    }
  }

  dispose() {
    if (!this.ctx) return;

    for (const coin of this.coins) {
      if (coin.mesh && coin.mesh.parent) {
        coin.mesh.parent.remove(coin.mesh);
        coin.mesh.geometry.dispose();
        coin.mesh.material.dispose();
      }
      if (coin.collider) {
        this.ctx.rapierWorld.removeCollider(coin.collider, false);
      }
      if (coin.body) {
        this.ctx.rapierWorld.removeRigidBody(coin.body);
      }
    }

    // Remove template mesh
    const template = this.ctx.meshRegistry.get('coin_mesh');
    if (template && template.parent) {
      template.parent.remove(template);
      template.geometry.dispose();
      template.material.dispose();
    }
    this.ctx.meshRegistry.delete('coin_mesh');

    this.coins = [];
    this.coinMeshes = [];
    this.coinBodies = [];
    this.coinColliders = [];
  }
}
