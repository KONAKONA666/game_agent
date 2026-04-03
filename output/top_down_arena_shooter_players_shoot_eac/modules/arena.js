export default class Arena {
  name = 'arena';

  async build(ctx) {
    this.ctx = ctx;
    this.meshes = [];
    this.bodies = [];

    const ARENA_W = 30;
    const ARENA_D = 30;
    const WALL_H = 2;
    const HALF_W = ARENA_W / 2;
    const HALF_D = ARENA_D / 2;

    // --- Scene visuals ---
    ctx.scene.background = new THREE.Color('#1a1a2e');
    ctx.scene.fog = new THREE.Fog('#1a1a2e', 30, 60);

    ctx.sunLight.color.set('#ffffff');
    ctx.sunLight.intensity = 0.4;

    ctx.hemiLight.color.set('#4a4a8a');
    ctx.hemiLight.intensity = 0.6;

    // --- Bloom pass ---
    const bloomPass = ctx.composer.passes.find(p => p instanceof UnrealBloomPass);
    if (bloomPass) {
      bloomPass.strength = 0.8;
      bloomPass.radius = 0.4;
      bloomPass.threshold = 0.6;
    }

    // --- Floor with grid ---
    const floorGeo = new THREE.PlaneGeometry(ARENA_W, ARENA_D);
    const floorCanvas = document.createElement('canvas');
    floorCanvas.width = 512;
    floorCanvas.height = 512;
    const fctx = floorCanvas.getContext('2d');
    fctx.fillStyle = '#0e0e1a';
    fctx.fillRect(0, 0, 512, 512);
    fctx.strokeStyle = '#2a2a5e';
    fctx.lineWidth = 1;
    const cellSize = 512 / ARENA_W;
    for (let i = 0; i <= ARENA_W; i++) {
      const p = i * cellSize;
      fctx.beginPath(); fctx.moveTo(p, 0); fctx.lineTo(p, 512); fctx.stroke();
      fctx.beginPath(); fctx.moveTo(0, p); fctx.lineTo(512, p); fctx.stroke();
    }
    const floorTex = new THREE.CanvasTexture(floorCanvas);
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTex });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.receiveShadow = true;
    ctx.scene.add(floorMesh);
    ctx.meshRegistry.set('arena_floor', floorMesh);
    this.meshes.push(floorMesh);

    // --- Walls ---
    const wallColor = '#3a3a6e';
    const wallMat = new THREE.MeshStandardMaterial({ color: wallColor });
    const wallGroup = new THREE.Group();

    const wallDefs = [
      // [width, height, depth, x, y, z]
      [ARENA_W, WALL_H, 0.5, 0, WALL_H / 2, -HALF_D - 0.25],  // north
      [ARENA_W, WALL_H, 0.5, 0, WALL_H / 2, HALF_D + 0.25],   // south
      [0.5, WALL_H, ARENA_D + 0.5, -HALF_W - 0.25, WALL_H / 2, 0], // west
      [0.5, WALL_H, ARENA_D + 0.5, HALF_W + 0.25, WALL_H / 2, 0],  // east
    ];

    for (const [w, h, d, x, y, z] of wallDefs) {
      const geo = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      wallGroup.add(mesh);
      this.meshes.push(mesh);

      // Rapier static body
      const bodyDesc = ctx.RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
      const body = ctx.rapierWorld.createRigidBody(bodyDesc);
      const colliderDesc = ctx.RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2);
      ctx.rapierWorld.createCollider(colliderDesc, body);
      this.bodies.push(body);
    }

    ctx.scene.add(wallGroup);
    ctx.meshRegistry.set('arena_wall', wallGroup);

    // --- Obstacles ---
    const obstacleMat = new THREE.MeshStandardMaterial({ color: '#2e2e5a' });
    const obstacleGroup = new THREE.Group();
    const obstaclePositions = [];
    const OBS_COUNT = 8;
    const MIN_SIZE = 1.5;
    const MAX_SIZE = 3;
    const MARGIN = 2;

    // Seeded random for deterministic placement
    let seed = 42;
    const seededRandom = () => {
      seed = (seed * 16807 + 0) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    for (let i = 0; i < OBS_COUNT; i++) {
      const sx = MIN_SIZE + seededRandom() * (MAX_SIZE - MIN_SIZE);
      const sz = MIN_SIZE + seededRandom() * (MAX_SIZE - MIN_SIZE);
      const sy = 1 + seededRandom() * 1.5;

      let ox, oz, attempts = 0, valid = false;
      while (attempts < 50) {
        ox = (seededRandom() - 0.5) * (ARENA_W - sx - MARGIN * 2);
        oz = (seededRandom() - 0.5) * (ARENA_D - sz - MARGIN * 2);
        valid = true;
        for (const pos of obstaclePositions) {
          const dx = Math.abs(ox - pos.x) - (sx / 2 + pos.sx / 2 + 1);
          const dz = Math.abs(oz - pos.z) - (sz / 2 + pos.sz / 2 + 1);
          if (dx < 0 && dz < 0) { valid = false; break; }
        }
        if (valid) break;
        attempts++;
      }

      obstaclePositions.push({ x: ox, z: oz, sx, sz });

      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const mesh = new THREE.Mesh(geo, obstacleMat);
      mesh.position.set(ox, sy / 2, oz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      obstacleGroup.add(mesh);
      this.meshes.push(mesh);

      // Rapier static body
      const bodyDesc = ctx.RAPIER.RigidBodyDesc.fixed().setTranslation(ox, sy / 2, oz);
      const body = ctx.rapierWorld.createRigidBody(bodyDesc);
      const colliderDesc = ctx.RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
      ctx.rapierWorld.createCollider(colliderDesc, body);
      this.bodies.push(body);
    }

    ctx.scene.add(obstacleGroup);
    ctx.meshRegistry.set('arena_obstacle', obstacleGroup);

    // --- Terrain height (flat arena) ---
    ctx.getTerrainHeight = () => 0;

    // --- Camera: top-down view ---
    ctx.camera.position.set(0, 25, 0);
    ctx.camera.rotation.set(-Math.PI / 2, 0, 0);
    ctx.camera.lookAt(0, 0, 0);
  }

  start() {}

  update(dt) {}

  dispose() {
    const ctx = this.ctx;
    for (const mesh of this.meshes) {
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
      if (mesh.parent) mesh.parent.remove(mesh);
    }
    for (const body of this.bodies) {
      ctx.rapierWorld.removeRigidBody(body);
    }
    ctx.meshRegistry.delete('arena_floor');
    ctx.meshRegistry.delete('arena_wall');
    ctx.meshRegistry.delete('arena_obstacle');
  }
}
