export default class Camera {
  name = 'camera';

  async build(ctx) {
    this.ctx = ctx;

    // Configure camera
    ctx.camera.fov = 60;
    ctx.camera.near = 0.1;
    ctx.camera.far = 300;
    ctx.camera.updateProjectionMatrix();

    // Offset behind and above player
    this.offset = new THREE.Vector3(0, 6, -12);
    this.currentPos = new THREE.Vector3();
    this.targetPos = new THREE.Vector3();
    this.velocity = new THREE.Vector3(); // spring-damper velocity
    this.lookTarget = new THREE.Vector3();

    // Orbit state
    this.orbiting = false;
    this.orbitTheta = Math.PI; // behind player (camera looks at +Z by default)
    this.orbitPhi = 0.4; // slight downward angle
    this.orbitDistance = 12;
    this.minDistance = 5;
    this.maxDistance = 20;

    // Spring-damper params
    this.springStiffness = 4.0;
    this.springDamping = 0.85;
    this.lerpFactor = 0.08;

    // Snap flag
    this.snapNext = true;

    // Bloom settings per visual_spec
    if (ctx.composer) {
      const passes = ctx.composer.passes;
      for (let i = 0; i < passes.length; i++) {
        const pass = passes[i];
        if (pass.strength !== undefined) {
          pass.strength = 0.3;
          pass.radius = 0.4;
          pass.threshold = 0.85;
        }
      }
    }

    // Mouse drag orbit
    this._onMouseDown = (e) => {
      if (e.button === 2 || e.button === 1) {
        this.orbiting = true;
        this._lastMx = e.clientX;
        this._lastMy = e.clientY;
      }
    };
    this._onMouseMove = (e) => {
      if (!this.orbiting) return;
      const dx = e.clientX - this._lastMx;
      const dy = e.clientY - this._lastMy;
      this._lastMx = e.clientX;
      this._lastMy = e.clientY;
      this.orbitTheta -= dx * 0.005;
      this.orbitPhi = Math.max(-0.2, Math.min(1.2, this.orbitPhi + dy * 0.005));
    };
    this._onMouseUp = () => {
      this.orbiting = false;
    };
    this._onWheel = (e) => {
      this.orbitDistance = Math.max(this.minDistance, Math.min(this.maxDistance,
        this.orbitDistance + e.deltaY * 0.01));
    };
    this._onContext = (e) => e.preventDefault();

    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('wheel', this._onWheel, { passive: true });
    document.addEventListener('contextmenu', this._onContext);

    // Listen for respawn to snap camera
    this._onRespawn = (e) => {
      const { position } = e.detail;
      this.snapNext = true;
    };
    ctx.eventBus.addEventListener('event:playerRespawn', this._onRespawn);

    this._onFell = () => {
      // Could add camera shake here; for now just prepare for snap on respawn
    };
    ctx.eventBus.addEventListener('event:playerFell', this._onFell);

    // Set initial camera position
    const spawn = ctx.gameConfig.spawnPosition || { x: 0, y: 10, z: 0 };
    this.currentPos.set(spawn.x + this.offset.x, spawn.y + this.offset.y, spawn.z + this.offset.z);
    ctx.camera.position.copy(this.currentPos);
    ctx.camera.lookAt(spawn.x, spawn.y + 1.5, spawn.z);
  }

  start() {}

  update(dt) {
    const player = this.ctx.modules.player;
    if (!player || !player.getPosition) return;

    const pos = player.getPosition();
    const vel = player.getVelocity ? player.getVelocity() : { x: 0, y: 0, z: 0 };

    // Compute desired camera position from orbit params
    const sinPhi = Math.sin(this.orbitPhi);
    const cosPhi = Math.cos(this.orbitPhi);
    const sinTheta = Math.sin(this.orbitTheta);
    const cosTheta = Math.cos(this.orbitTheta);

    const dist = this.orbitDistance;
    this.targetPos.set(
      pos.x + dist * cosPhi * sinTheta,
      pos.y + dist * sinPhi + 2,
      pos.z + dist * cosPhi * cosTheta
    );

    // Add look-ahead based on velocity
    const lookAhead = 0.4;
    this.targetPos.x += vel.x * lookAhead;
    this.targetPos.z += vel.z * lookAhead;

    if (this.snapNext) {
      this.currentPos.copy(this.targetPos);
      this.velocity.set(0, 0, 0);
      this.snapNext = false;
    } else {
      // Spring-damper model
      const stiffness = this.springStiffness;
      const damping = this.springDamping;

      // Spring force: F = -k * (current - target) - d * velocity
      const fx = -stiffness * (this.currentPos.x - this.targetPos.x) - damping * this.velocity.x;
      const fy = -stiffness * (this.currentPos.y - this.targetPos.y) - damping * this.velocity.y;
      const fz = -stiffness * (this.currentPos.z - this.targetPos.z) - damping * this.velocity.z;

      this.velocity.x += fx * dt;
      this.velocity.y += fy * dt;
      this.velocity.z += fz * dt;

      // Also blend with lerp for stability
      this.currentPos.x += this.velocity.x * dt;
      this.currentPos.y += this.velocity.y * dt;
      this.currentPos.z += this.velocity.z * dt;

      // Additional lerp smoothing
      this.currentPos.lerp(this.targetPos, this.lerpFactor);
    }

    // Rapier raycast: check if terrain blocks camera view
    if (this.ctx.rapierWorld && this.ctx.RAPIER) {
      const RAPIER = this.ctx.RAPIER;
      const origin = { x: pos.x, y: pos.y + 1.5, z: pos.z };
      const dir = {
        x: this.currentPos.x - origin.x,
        y: this.currentPos.y - origin.y,
        z: this.currentPos.z - origin.z
      };
      const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
      if (len > 0.01) {
        const invLen = 1.0 / len;
        dir.x *= invLen;
        dir.y *= invLen;
        dir.z *= invLen;

        const ray = new RAPIER.Ray(origin, dir);
        const hit = this.ctx.rapierWorld.castRay(ray, len, true);
        if (hit && hit.toi < len - 0.5) {
          // Pull camera closer to avoid clipping
          const t = hit.toi * 0.9; // slightly in front of hit
          this.currentPos.set(
            origin.x + dir.x * t,
            origin.y + dir.y * t,
            origin.z + dir.z * t
          );
        }
      }
    }

    // Apply position
    this.ctx.camera.position.copy(this.currentPos);

    // Look at point slightly above player
    this.lookTarget.set(pos.x, pos.y + 1.5, pos.z);
    this.ctx.camera.lookAt(this.lookTarget);
  }

  dispose() {
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('contextmenu', this._onContext);
    if (this.ctx) {
      this.ctx.eventBus.removeEventListener('event:playerRespawn', this._onRespawn);
      this.ctx.eventBus.removeEventListener('event:playerFell', this._onFell);
    }
  }
}
