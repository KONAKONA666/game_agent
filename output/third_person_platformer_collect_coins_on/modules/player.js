export default class Player {
  name = 'player';

  async build(ctx) {
    this.ctx = ctx;
    this.keys = { forward: false, backward: false, left: false, right: false, jump: false };
    this.jumpCount = 0;
    this.maxJumps = 2;
    this.moveSpeed = 8;
    this.jumpForce = 12;
    this.fallDeathY = -20;
    this.spawnPosition = { x: 0, y: 10, z: 0 };
    this.grounded = false;
    this.groundedCooldown = 0;
    this.syncTimer = 0;
    this.syncInterval = 1 / 20; // 20 Hz
    this.ghosts = new Map(); // sessionId -> { mesh, targetPos, targetVel }
    this.respawning = false;

    const RAPIER = ctx.RAPIER;

    // Player colors
    this.playerColors = [0xFF5722, 0x2196F3, 0x9C27B0, 0xFFEB3B];

    // Create player mesh - capsule
    const capsuleGeo = new THREE.CapsuleGeometry(0.4, 1.0, 8, 16);
    const capsuleMat = new THREE.MeshStandardMaterial({ color: this.playerColors[0] });
    this.mesh = new THREE.Mesh(capsuleGeo, capsuleMat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    ctx.scene.add(this.mesh);
    ctx.meshRegistry.set('player_model', this.mesh);

    // Create Rapier rigid body
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(this.spawnPosition.x, this.spawnPosition.y, this.spawnPosition.z)
      .setLinearDamping(0.5)
      .lockRotations();
    this.rigidBody = ctx.rapierWorld.createRigidBody(bodyDesc);

    // Capsule collider (half-height=0.5, radius=0.4)
    const colliderDesc = RAPIER.ColliderDesc.capsule(0.5, 0.4)
      .setFriction(0.5)
      .setRestitution(0.0);
    this.collider = ctx.rapierWorld.createCollider(colliderDesc, this.rigidBody);

    // Keyboard input
    this._onKeyDown = (e) => this._handleKey(e, true);
    this._onKeyUp = (e) => this._handleKey(e, false);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    // Expose interface
    this.getPosition = () => {
      const pos = this.rigidBody.translation();
      return { x: pos.x, y: pos.y, z: pos.z };
    };
    this.getVelocity = () => {
      const vel = this.rigidBody.linvel();
      return { x: vel.x, y: vel.y, z: vel.z };
    };

    // Register network handlers if network is available
    this._registerNetworkHandlers();
  }

  _registerNetworkHandlers() {
    const ctx = this.ctx;
    const net = ctx.modules.network;
    if (!net) return;

    net.onMessage('playerJoined', (data) => {
      if (this.ghosts.has(data.sessionId)) return;
      const colorIndex = this.ghosts.size + 1;
      const color = this.playerColors[colorIndex % this.playerColors.length];
      const geo = new THREE.CapsuleGeometry(0.4, 1.0, 8, 16);
      const mat = new THREE.MeshStandardMaterial({ color });
      const ghostMesh = new THREE.Mesh(geo, mat);
      ghostMesh.castShadow = true;
      ghostMesh.position.set(data.x || 0, data.y || 10, data.z || 0);
      ctx.scene.add(ghostMesh);
      this.ghosts.set(data.sessionId, {
        mesh: ghostMesh,
        targetPos: { x: data.x || 0, y: data.y || 10, z: data.z || 0 },
        targetVel: { x: 0, y: 0, z: 0 }
      });
    });

    net.onMessage('playerLeave', (data) => {
      const ghost = this.ghosts.get(data.sessionId);
      if (ghost) {
        ctx.scene.remove(ghost.mesh);
        ghost.mesh.geometry.dispose();
        ghost.mesh.material.dispose();
        this.ghosts.delete(data.sessionId);
      }
    });

    net.onMessage('gameState', (data) => {
      if (!data.players) return;
      const myId = net.getSessionId();
      for (const [sid, pdata] of Object.entries(data.players)) {
        if (sid === myId) continue;
        let ghost = this.ghosts.get(sid);
        if (!ghost) {
          // Auto-create ghost for unknown players
          const colorIndex = this.ghosts.size + 1;
          const color = this.playerColors[colorIndex % this.playerColors.length];
          const geo = new THREE.CapsuleGeometry(0.4, 1.0, 8, 16);
          const mat = new THREE.MeshStandardMaterial({ color });
          const ghostMesh = new THREE.Mesh(geo, mat);
          ghostMesh.castShadow = true;
          ctx.scene.add(ghostMesh);
          ghost = {
            mesh: ghostMesh,
            targetPos: { x: pdata.x, y: pdata.y, z: pdata.z },
            targetVel: { x: pdata.vx || 0, y: pdata.vy || 0, z: pdata.vz || 0 }
          };
          this.ghosts.set(sid, ghost);
        }
        ghost.targetPos = { x: pdata.x, y: pdata.y, z: pdata.z };
        ghost.targetVel = { x: pdata.vx || 0, y: pdata.vy || 0, z: pdata.vz || 0 };
      }
    });
  }

  _handleKey(e, down) {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    this.keys.forward = down; break;
      case 'KeyS': case 'ArrowDown':  this.keys.backward = down; break;
      case 'KeyA': case 'ArrowLeft':  this.keys.left = down; break;
      case 'KeyD': case 'ArrowRight': this.keys.right = down; break;
      case 'Space':
        if (down && !e.repeat) this.keys.jump = true;
        break;
    }
  }

  start() {
    // Emit initial spawn event
    this.ctx.eventBus.dispatchEvent(new CustomEvent('event:playerRespawn', {
      detail: { playerId: this._getPlayerId(), position: { ...this.spawnPosition } }
    }));
  }

  update(dt) {
    if (this.respawning) return;

    const vel = this.rigidBody.linvel();
    const pos = this.rigidBody.translation();

    // Ground detection via velocity
    if (this.groundedCooldown > 0) {
      this.groundedCooldown -= dt;
    }
    const wasGrounded = this.grounded;
    if (Math.abs(vel.y) < 0.5 && this.groundedCooldown <= 0) {
      this.grounded = true;
      this.jumpCount = 0;
    } else if (Math.abs(vel.y) > 1.0) {
      this.grounded = false;
    }

    // Movement forces
    let moveX = 0, moveZ = 0;
    // Get camera forward/right for camera-relative movement
    const cam = this.ctx.camera;
    const forward = new THREE.Vector3();
    cam.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    if (this.keys.forward)  { moveX += forward.x; moveZ += forward.z; }
    if (this.keys.backward) { moveX -= forward.x; moveZ -= forward.z; }
    if (this.keys.left)     { moveX -= right.x; moveZ -= right.z; }
    if (this.keys.right)    { moveX += right.x; moveZ += right.z; }

    const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (len > 0) {
      moveX = (moveX / len) * this.moveSpeed;
      moveZ = (moveZ / len) * this.moveSpeed;
    }

    // Apply horizontal velocity directly for responsive control
    this.rigidBody.setLinvel({ x: moveX, y: vel.y, z: moveZ }, true);

    // Jump
    if (this.keys.jump) {
      this.keys.jump = false;
      if (this.jumpCount < this.maxJumps) {
        this.rigidBody.setLinvel({ x: vel.x, y: this.jumpForce, z: vel.z }, true);
        this.jumpCount++;
        this.grounded = false;
        this.groundedCooldown = 0.15;

        const net = this.ctx.modules.network;
        if (net) {
          net.send('playerJump', { x: pos.x, y: pos.y, z: pos.z });
        }
      }
    }

    // Update mesh position
    const newPos = this.rigidBody.translation();
    this.mesh.position.set(newPos.x, newPos.y, newPos.z);

    // Fall death check
    if (newPos.y < this.fallDeathY) {
      this._respawn();
      return;
    }

    // Network sync
    this.syncTimer += dt;
    if (this.syncTimer >= this.syncInterval) {
      this.syncTimer = 0;
      const net = this.ctx.modules.network;
      if (net) {
        const v = this.rigidBody.linvel();
        net.send('playerMove', {
          x: newPos.x, y: newPos.y, z: newPos.z,
          vx: v.x, vy: v.y, vz: v.z,
          grounded: this.grounded
        });
      }
    }

    // Interpolate ghost positions
    for (const [sid, ghost] of this.ghosts) {
      const lerpSpeed = 10 * dt;
      ghost.mesh.position.x += (ghost.targetPos.x - ghost.mesh.position.x) * lerpSpeed;
      ghost.mesh.position.y += (ghost.targetPos.y - ghost.mesh.position.y) * lerpSpeed;
      ghost.mesh.position.z += (ghost.targetPos.z - ghost.mesh.position.z) * lerpSpeed;
    }
  }

  _getPlayerId() {
    const net = this.ctx.modules.network;
    return net ? net.getSessionId() : 'local';
  }

  _respawn() {
    this.respawning = true;
    const playerId = this._getPlayerId();

    // Emit fell event
    this.ctx.eventBus.dispatchEvent(new CustomEvent('event:playerFell', {
      detail: { playerId }
    }));

    // Determine spawn position - use first island if available, else default
    let spawnPos = { ...this.spawnPosition };
    if (this.ctx.getIslandPositions) {
      const islands = this.ctx.getIslandPositions();
      if (islands.length > 0) {
        spawnPos.x = islands[0].x;
        spawnPos.z = islands[0].z;
        spawnPos.y = islands[0].y + 3;
      }
    }

    setTimeout(() => {
      this.rigidBody.setTranslation({ x: spawnPos.x, y: spawnPos.y, z: spawnPos.z }, true);
      this.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.mesh.position.set(spawnPos.x, spawnPos.y, spawnPos.z);
      this.jumpCount = 0;
      this.grounded = false;
      this.respawning = false;

      this.ctx.eventBus.dispatchEvent(new CustomEvent('event:playerRespawn', {
        detail: { playerId, position: { ...spawnPos } }
      }));
    }, 1000);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);

    if (this.mesh) {
      this.ctx.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }

    for (const [sid, ghost] of this.ghosts) {
      this.ctx.scene.remove(ghost.mesh);
      ghost.mesh.geometry.dispose();
      ghost.mesh.material.dispose();
    }
    this.ghosts.clear();

    if (this.rigidBody) {
      this.ctx.rapierWorld.removeRigidBody(this.rigidBody);
    }

    this.ctx.meshRegistry.delete('player_model');
  }
}
