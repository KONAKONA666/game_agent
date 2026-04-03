export default class Environment {
  name = 'environment';

  _islands = [];
  _islandBodies = [];
  _islandMeshes = [];
  _cloudSprites = [];
  _ctx = null;

  async build(ctx) {
    this._ctx = ctx;
    const RAPIER = ctx.RAPIER;

    // --- Sky & Fog ---
    ctx.scene.background = new THREE.Color('#87CEEB');
    ctx.scene.fog = new THREE.Fog('#C8E6FF', 50, 200);

    // --- Sun light ---
    ctx.sunLight.color.set('#FFFAE6');
    ctx.sunLight.intensity = 1.4;
    ctx.sunLight.position.set(50, 80, 30);
    ctx.sunLight.castShadow = true;
    ctx.sunLight.shadow.mapSize.width = 2048;
    ctx.sunLight.shadow.mapSize.height = 2048;
    ctx.sunLight.shadow.camera.near = 1;
    ctx.sunLight.shadow.camera.far = 200;
    ctx.sunLight.shadow.camera.left = -60;
    ctx.sunLight.shadow.camera.right = 60;
    ctx.sunLight.shadow.camera.top = 60;
    ctx.sunLight.shadow.camera.bottom = -60;

    // --- Hemisphere light ---
    ctx.hemiLight.color.set('#FFFAE6');
    ctx.hemiLight.groundColor.set('#4CAF50');
    ctx.hemiLight.intensity = 0.6;

    // --- Island palette ---
    const palette = ['#4CAF50', '#8BC34A', '#689F38', '#33691E'].map(
      c => new THREE.Color(c)
    );

    // --- Define islands ---
    const centerIsland = { x: 0, y: 8, z: 0, radius: 10 };
    const ringIslands = [];
    const ringCount = 6;
    const ringDistance = 22;

    for (let i = 0; i < ringCount; i++) {
      const angle = (i / ringCount) * Math.PI * 2;
      const radius = 4 + Math.random() * 6; // 4-10
      const height = 2 + Math.random() * 23; // 2-25
      const dist = ringDistance + (Math.random() - 0.5) * 6;
      ringIslands.push({
        x: Math.cos(angle) * dist,
        y: height,
        z: Math.sin(angle) * dist,
        radius
      });
    }

    this._islands = [centerIsland, ...ringIslands];

    // --- Create template mesh and register ---
    const templateMesh = this._createIslandMesh(5, palette);
    ctx.meshRegistry.set('island_base', templateMesh);

    // --- Create each island ---
    for (const island of this._islands) {
      const mesh = this._createIslandMesh(island.radius, palette);
      mesh.position.set(island.x, island.y, island.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      ctx.scene.add(mesh);
      this._islandMeshes.push(mesh);

      // Physics: trimesh collider on a static body
      const bodyDesc = RAPIER.RigidBodyDesc.fixed()
        .setTranslation(island.x, island.y, island.z);
      const body = ctx.rapierWorld.createRigidBody(bodyDesc);

      // Extract vertices and indices from the merged geometry
      const geo = mesh.geometry;
      const vertices = new Float32Array(geo.attributes.position.array);
      const indices = new Uint32Array(geo.index.array);

      const colliderDesc = RAPIER.ColliderDesc.trimesh(vertices, indices);
      ctx.rapierWorld.createCollider(colliderDesc, body);
      this._islandBodies.push(body);
    }

    // --- ctx.getIslandPositions ---
    ctx.getIslandPositions = () => {
      return this._islands.map(i => ({
        x: i.x, y: i.y, z: i.z, radius: i.radius
      }));
    };

    // --- ctx.getTerrainHeight using Rapier raycast ---
    ctx.getTerrainHeight = (x, z) => {
      const origin = { x, y: 100, z };
      const direction = { x: 0, y: -1, z: 0 };
      const ray = new RAPIER.Ray(origin, direction);
      const hit = ctx.rapierWorld.castRay(ray, 200, true);
      if (hit) {
        const point = ray.pointAt(hit.toi);
        return point.y;
      }
      return -Infinity;
    };

    // --- Add cloud sprites ---
    this._addClouds(ctx);
  }

  _createIslandMesh(radius, palette) {
    // Top: flattened cylinder
    const topHeight = 0.8;
    const topGeo = new THREE.CylinderGeometry(radius, radius * 0.95, topHeight, 24, 1);

    // Bottom: inverted cone (rocky underside)
    const bottomHeight = radius * 0.8;
    const bottomGeo = new THREE.ConeGeometry(radius * 0.95, bottomHeight, 24, 2);
    // Flip cone and position below top
    bottomGeo.scale(1, -1, 1);
    bottomGeo.translate(0, -topHeight / 2 - bottomHeight / 2, 0);

    // Merge geometries
    const mergedGeo = this._mergeBufferGeometries(topGeo, bottomGeo);

    // Apply vertex colors with variation
    const posAttr = mergedGeo.attributes.position;
    const count = posAttr.count;
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const y = posAttr.getY(i);
      let baseColor;
      if (y >= -topHeight / 2) {
        // Top surface - greens
        baseColor = palette[Math.floor(Math.random() * 2)]; // lighter greens
      } else {
        // Rocky bottom - darker greens/browns
        baseColor = palette[2 + Math.floor(Math.random() * 2)];
      }
      // Add slight variation
      const variation = 0.9 + Math.random() * 0.2;
      colors[i * 3] = baseColor.r * variation;
      colors[i * 3 + 1] = baseColor.g * variation;
      colors[i * 3 + 2] = baseColor.b * variation;
    }
    mergedGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.05,
      flatShading: true
    });

    const mesh = new THREE.Mesh(mergedGeo, mat);
    return mesh;
  }

  _mergeBufferGeometries(geo1, geo2) {
    // Simple merge of two geometries into one
    const pos1 = geo1.attributes.position;
    const pos2 = geo2.attributes.position;
    const norm1 = geo1.attributes.normal;
    const norm2 = geo2.attributes.normal;

    const totalVerts = pos1.count + pos2.count;
    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);

    positions.set(pos1.array, 0);
    positions.set(pos2.array, pos1.count * 3);
    normals.set(norm1.array, 0);
    normals.set(norm2.array, norm1.count * 3);

    // Indices
    const idx1 = geo1.index ? Array.from(geo1.index.array) : [];
    const idx2 = geo2.index ? Array.from(geo2.index.array) : [];
    // If no index, generate sequential
    const indices1 = idx1.length ? idx1 : Array.from({ length: pos1.count }, (_, i) => i);
    const indices2 = idx2.length ? idx2.map(i => i + pos1.count) : Array.from({ length: pos2.count }, (_, i) => i + pos1.count);

    const mergedIndices = new Uint32Array([...indices1, ...indices2]);

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    merged.setIndex(new THREE.BufferAttribute(mergedIndices, 1));

    return merged;
  }

  _addClouds(ctx) {
    // Simple cloud billboards between islands
    const cloudGeo = new THREE.PlaneGeometry(6, 3);
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const c = canvas.getContext('2d');
    const grad = c.createRadialGradient(64, 32, 5, 64, 32, 50);
    grad.addColorStop(0, 'rgba(255,255,255,0.8)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = grad;
    c.fillRect(0, 0, 128, 64);
    const cloudTex = new THREE.CanvasTexture(canvas);

    const cloudMat = new THREE.MeshBasicMaterial({
      map: cloudTex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: 0.6
    });

    for (let i = 0; i < 15; i++) {
      const cloud = new THREE.Mesh(cloudGeo, cloudMat);
      cloud.position.set(
        (Math.random() - 0.5) * 80,
        5 + Math.random() * 20,
        (Math.random() - 0.5) * 80
      );
      cloud.scale.setScalar(1 + Math.random() * 2);
      cloud.rotation.y = Math.random() * Math.PI;
      ctx.scene.add(cloud);
      this._cloudSprites.push(cloud);
    }
  }

  start() {
    // No informational events to emit for environment
  }

  update(dt) {
    // Slowly drift clouds
    for (const cloud of this._cloudSprites) {
      cloud.position.x += dt * 0.3;
      if (cloud.position.x > 50) cloud.position.x = -50;
      // Billboard: face camera
      if (this._ctx && this._ctx.camera) {
        cloud.lookAt(this._ctx.camera.position);
      }
    }
  }

  dispose() {
    const ctx = this._ctx;
    if (!ctx) return;

    for (const mesh of this._islandMeshes) {
      ctx.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    for (const cloud of this._cloudSprites) {
      ctx.scene.remove(cloud);
    }
    for (const body of this._islandBodies) {
      ctx.rapierWorld.removeRigidBody(body);
    }

    this._islandMeshes = [];
    this._cloudSprites = [];
    this._islandBodies = [];
    this._islands = [];
  }
}
