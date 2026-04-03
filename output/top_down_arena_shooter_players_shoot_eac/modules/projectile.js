export default class ProjectileModule {
  name = 'projectile';

  constructor() {
    this._projectiles = [];
    this._ctx = null;
    this._templateMesh = null;
    this._speed = 20;
    this._maxLifetime = 2;
    this._damage = 25;
    this._hitRadius = 0.5;
    this._arenaHalfW = 15;
    this._arenaHalfD = 15;
    this._onPlayerShoot = null;
  }

  async build(ctx) {
    this._ctx = ctx;

    // Create projectile template mesh
    const geo = new THREE.SphereGeometry(0.15, 8, 8);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff4444,
      emissive: 0xff0000,
      emissiveIntensity: 2
    });
    this._templateMesh = new THREE.Mesh(geo, mat);
    this._templateMesh.visible = false;
    ctx.meshRegistry.set('projectile_mesh', this._templateMesh);

    // Arena bounds from config
    const ac = ctx.gameConfig;
    if (ac.worldWidth) {
      this._arenaHalfW = ac.worldWidth / 2;
      this._arenaHalfD = ac.worldDepth / 2;
    }

    // Listen for local playerShoot event
    this._onPlayerShoot = (e) => {
      const d = e.detail;
      this._spawnProjectile(d.sessionId, d.originX, d.originZ, d.dirX, d.dirZ);
    };
    ctx.eventBus.addEventListener('event:playerShoot', this._onPlayerShoot);
  }

  _spawnProjectile(shooterId, ox, oz, dirX, dirZ) {
    const ctx = this._ctx;
    const mesh = this._templateMesh.clone();
    mesh.visible = true;

    const y = ctx.getTerrainHeight ? ctx.getTerrainHeight(ox, oz) + 0.8 : 0.8;
    mesh.position.set(ox, y, oz);
    ctx.scene.add(mesh);

    // Point light for glow
    const light = new THREE.PointLight(0xff4444, 1, 5);
    light.position.set(0, 0, 0);
    mesh.add(light);

    // Normalize direction
    const len = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
    const ndx = dirX / len;
    const ndz = dirZ / len;

    this._projectiles.push({
      mesh,
      light,
      shooterId,
      vx: ndx * this._speed,
      vz: ndz * this._speed,
      age: 0
    });
  }

  start() {}

  update(dt) {
    const ctx = this._ctx;
    const toRemove = [];

    for (let i = 0; i < this._projectiles.length; i++) {
      const p = this._projectiles[i];
      p.age += dt;

      // Remove if exceeded lifetime
      if (p.age >= this._maxLifetime) {
        toRemove.push(i);
        continue;
      }

      // Move projectile
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.z += p.vz * dt;

      const px = p.mesh.position.x;
      const pz = p.mesh.position.z;

      // Wall collision
      if (px < -this._arenaHalfW || px > this._arenaHalfW ||
          pz < -this._arenaHalfD || pz > this._arenaHalfD) {
        toRemove.push(i);
        continue;
      }

      // Obstacle collision via Rapier raycast
      if (ctx.rapierWorld) {
        const origin = { x: px, y: p.mesh.position.y, z: pz };
        const dir = { x: p.vx, y: 0, z: p.vz };
        const dirLen = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
        if (dirLen > 0) {
          const nd = { x: dir.x / dirLen, y: 0, z: dir.z / dirLen };
          const ray = new ctx.RAPIER.Ray(origin, nd);
          const hit = ctx.rapierWorld.castRay(ray, 0.3, true);
          if (hit && hit.timeOfImpact < 0.3) {
            toRemove.push(i);
            continue;
          }
        }
      }

      // Player hit detection
      if (ctx.modules.player && ctx.modules.player.getAllPlayers) {
        const players = ctx.modules.player.getAllPlayers();
        let hitPlayer = false;
        players.forEach((pos, sessionId) => {
          if (hitPlayer) return;
          if (sessionId === p.shooterId) return;

          const dx = px - pos.x;
          const dz = pz - pos.z;
          const dist = Math.sqrt(dx * dx + dz * dz);

          if (dist < this._hitRadius) {
            ctx.eventBus.dispatchEvent(new CustomEvent('event:projectileHit', {
              detail: {
                shooterSessionId: p.shooterId,
                victimSessionId: sessionId,
                damage: this._damage
              }
            }));
            hitPlayer = true;
            toRemove.push(i);
          }
        });
      }
    }

    // Remove projectiles in reverse order
    for (let i = toRemove.length - 1; i >= 0; i--) {
      const idx = toRemove[i];
      const p = this._projectiles[idx];
      ctx.scene.remove(p.mesh);
      if (p.mesh.geometry) p.mesh.geometry.dispose();
      if (p.mesh.material) p.mesh.material.dispose();
      this._projectiles.splice(idx, 1);
    }
  }

  dispose() {
    const ctx = this._ctx;
    if (this._onPlayerShoot) {
      ctx.eventBus.removeEventListener('event:playerShoot', this._onPlayerShoot);
    }
    for (const p of this._projectiles) {
      ctx.scene.remove(p.mesh);
      if (p.mesh.geometry) p.mesh.geometry.dispose();
      if (p.mesh.material) p.mesh.material.dispose();
    }
    this._projectiles = [];
    if (this._templateMesh) {
      if (this._templateMesh.geometry) this._templateMesh.geometry.dispose();
      if (this._templateMesh.material) this._templateMesh.material.dispose();
    }
    ctx.meshRegistry.delete('projectile_mesh');
  }
}
