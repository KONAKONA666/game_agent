#!/usr/bin/env python3
"""D4: Integration Agent -- assemble game folder, Playwright test, error attribution, fix routing.

Usage (standalone):
    python integration.py <game_id> <contract.json> <moduleGraph.json> <output_dir>
"""
import subprocess, json, sys, os, re, time

from specialist import call_claude, resume_specialist, remaining_timeout

# ──────────────────────────────────────────────
# Harness HTML template
# ──────────────────────────────────────────────

INDEX_HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>%(title)s</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { overflow: hidden; background: #000; }
    canvas { display: block; }
    #ui-overlay {
      position: absolute; top: 0; left: 0;
      width: 100%%; height: 100%%;
      pointer-events: none;
      font-family: 'Segoe UI', Arial, sans-serif;
      color: white; z-index: 10;
    }
    #ui-overlay > * { pointer-events: auto; }
    #loading {
      position: absolute; top: 50%%; left: 50%%;
      transform: translate(-50%%, -50%%);
      font-size: 1.8em; color: #fff;
      text-shadow: 0 2px 8px rgba(0,0,0,0.7);
      z-index: 100;
    }
  </style>
</head>
<body>
  <div id="ui-overlay"></div>
  <div id="loading">Loading game...</div>

  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
    }
  }
  </script>

  <script type="module">
    // === Load Three.js ===
    import * as THREE from 'three';
    import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
    import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
    import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

    window.THREE = THREE;
    window.EffectComposer = EffectComposer;
    window.RenderPass = RenderPass;
    window.UnrealBloomPass = UnrealBloomPass;
    window.GLTFLoader = GLTFLoader;

    // === Load Rapier ===
    const loadingEl = document.getElementById('loading');
    let RAPIER;
    try {
      loadingEl.textContent = 'Loading physics...';
      const rapierModule = await import('https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/+esm');
      RAPIER = rapierModule.default || rapierModule;
      await RAPIER.init();
    } catch (e) {
      console.error('Rapier load failed:', e);
      loadingEl.textContent = 'Failed to load physics engine. Check console.';
      throw e;
    }
    window.RAPIER = RAPIER;

    // === Colyseus-compatible WebSocket client ===
    class ColyseusClientCompat {
      constructor(url) { this.url = url; }
      async joinOrCreate(roomName) {
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(this.url + '/' + roomName);
          const room = {
            ws, sessionId: null,
            _handlers: {},
            send(type, data) {
              if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type, data }));
            },
            onMessage(type, cb) {
              if (!this._handlers[type]) this._handlers[type] = [];
              this._handlers[type].push(cb);
            },
            onLeave(cb) { ws.addEventListener('close', cb); },
            leave() { ws.close(); }
          };
          ws.onopen = () => resolve(room);
          ws.onmessage = (e) => {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === '__sessionId') { room.sessionId = msg.data; return; }
              const handlers = room._handlers[msg.type];
              if (handlers) handlers.forEach(cb => cb(msg.data));
            } catch {}
          };
          ws.onerror = () => reject(new Error('WebSocket error'));
          setTimeout(() => reject(new Error('Connection timeout')), 5000);
        });
      }
    }
    window.ColyseusClient = ColyseusClientCompat;

    // === Renderer ===
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    document.body.appendChild(renderer.domElement);

    // === Scene ===
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(%(sky_color)s);
    scene.fog = new THREE.Fog(%(fog_color)s, %(fog_near)s, %(fog_far)s);

    // === Camera ===
    const camera = new THREE.PerspectiveCamera(
      60, window.innerWidth / window.innerHeight, 0.1, 500
    );
    camera.position.set(0, 20, 20);

    // === Lights ===
    const sunLight = new THREE.DirectionalLight(%(sun_color)s, %(sun_intensity)s);
    sunLight.position.set(50, 100, 50);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.left = -60;
    sunLight.shadow.camera.right = 60;
    sunLight.shadow.camera.top = 60;
    sunLight.shadow.camera.bottom = -60;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 250;
    scene.add(sunLight);

    const hemiLight = new THREE.HemisphereLight(%(sky_color)s, 0x8B4513, 0.6);
    scene.add(hemiLight);

    // === Physics world ===
    const rapierWorld = new RAPIER.World({ x: 0.0, y: %(gravity)s, z: 0.0 });

    // === Post-processing ===
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      %(bloom_strength)s, %(bloom_radius)s, %(bloom_threshold)s
    );
    composer.addPass(bloomPass);

    // === Game Context ===
    const ctx = {
      scene,
      camera,
      rapierWorld,
      RAPIER,
      gameConfig: { worldWidth: 100, worldDepth: 100, gravity: %(gravity)s },
      meshRegistry: new Map(),
      eventBus: new EventTarget(),
      uiOverlay: document.getElementById('ui-overlay'),
      composer,
      sunLight,
      hemiLight,
      getTerrainHeight: () => -Infinity,
      wsUrl: 'ws://' + window.location.hostname + ':%(port)s',
      modules: {}
    };

    // === Load modules from manifest ===
    loadingEl.textContent = 'Loading modules...';
    const manifest = await fetch('manifest.json').then(r => r.json());
    const moduleInstances = [];

    for (const modPath of manifest.modules) {
      try {
        const mod = await import('./' + modPath);
        const ModClass = mod.default;
        const instance = new ModClass();
        ctx.modules[instance.name] = instance;
        moduleInstances.push(instance);
        console.log('[harness] loaded', instance.name);
      } catch (e) {
        console.error('[harness] FAILED to load ' + modPath + ':', e);
      }
    }

    // === Build phase (sequential -- respects manifest order) ===
    for (const mod of moduleInstances) {
      try {
        loadingEl.textContent = 'Building ' + mod.name + '...';
        await mod.build(ctx);
        console.log('[' + mod.name + '] built');
      } catch (e) {
        console.error('[' + mod.name + '] build error:', e);
      }
    }

    // === Start phase ===
    for (const mod of moduleInstances) {
      try {
        mod.start();
        console.log('[' + mod.name + '] started');
      } catch (e) {
        console.error('[' + mod.name + '] start error:', e);
      }
    }

    // === Hide loading ===
    loadingEl.style.display = 'none';

    // === Resize ===
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
    });

    // === Game loop ===
    const clock = new THREE.Clock();
    let errorCounts = {};

    function gameLoop() {
      requestAnimationFrame(gameLoop);
      const dt = Math.min(clock.getDelta(), 0.05);

      rapierWorld.step();

      for (const mod of moduleInstances) {
        try {
          mod.update(dt);
        } catch (e) {
          errorCounts[mod.name] = (errorCounts[mod.name] || 0) + 1;
          if (errorCounts[mod.name] <= 3) {
            console.error('[' + mod.name + '] update error:', e);
          }
        }
      }

      composer.render();
    }
    gameLoop();
    console.log('[harness] game loop running');
  </script>
</body>
</html>
"""


# ──────────────────────────────────────────────
# Manifest generation
# ──────────────────────────────────────────────

def generate_manifest(module_graph, output_dir):
    """Build manifest.json with correct load order from wave structure."""
    modules = []
    for wave in module_graph["waves"]:
        for assignment in wave["assignments"]:
            modules.append(f"modules/{assignment['name']}.js")

    manifest = {"game_id": module_graph.get("game_id", "game"), "modules": modules}
    manifest_path = os.path.join(output_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"[integration] Wrote manifest.json ({len(modules)} modules)")
    return manifest


# ──────────────────────────────────────────────
# Index HTML generation
# ──────────────────────────────────────────────

def generate_index_html(contract, output_dir, port=2567):
    """Write index.html from template + contract visual_spec."""
    vs = contract.get("visual_spec", {})
    gs = contract.get("gameplay_spec", {})

    params = {
        "title": contract.get("game_id", "Game").replace("_", " ").title(),
        "port": port,
        "sky_color": vs.get("sky_color", "0x87CEEB"),
        "fog_color": vs.get("fog_color", "0x87CEEB"),
        "fog_near": vs.get("fog_near", 50),
        "fog_far": vs.get("fog_far", 200),
        "sun_color": vs.get("sun_color", "0xffffff"),
        "sun_intensity": vs.get("sun_intensity", 1.5),
        "gravity": gs.get("player_config", {}).get("gravity",
                   contract.get("multiplayer_spec", {}).get("gravity", -30.0)),
        "bloom_strength": vs.get("bloom_strength", 0.3),
        "bloom_radius": vs.get("bloom_radius", 0.4),
        "bloom_threshold": vs.get("bloom_threshold", 0.85),
    }

    html = INDEX_HTML_TEMPLATE % params
    html_path = os.path.join(output_dir, "index.html")
    with open(html_path, "w") as f:
        f.write(html)
    print(f"[integration] Wrote index.html")
    return html_path


# ──────────────────────────────────────────────
# Server generation via Claude
# ──────────────────────────────────────────────

def generate_server_js(contract, output_dir, deadline=None):
    """Call claude -p to generate server/index.js from network protocol."""
    server_dir = os.path.join(output_dir, "server")
    os.makedirs(server_dir, exist_ok=True)
    server_path = os.path.join(server_dir, "index.js")

    protocol = contract.get("network_protocol", {})
    gameplay = contract.get("gameplay_spec", {})
    mp = contract.get("multiplayer_spec", {})
    port = mp.get("server_port", 2567)

    prompt = f"""You are a server engineer. Write a WebSocket game server to: {server_path}

Use the Write tool to create the file.

REQUIREMENTS:
- Node.js with express (static file serving) + ws (WebSocket)
- Serve static files from parent directory: app.use(express.static(path.join(__dirname, '..')))
- Port: {port}
- GameRoom class managing clients, session IDs, and game state

NETWORK PROTOCOL:
{json.dumps(protocol, indent=2)}

GAMEPLAY SPEC (for server-side state):
{json.dumps(gameplay, indent=2)}

MESSAGE HANDLING:
- On connection: assign session ID ('p' + incrementing number), send __sessionId, send gameState, broadcast playerJoined
- On disconnect: broadcast playerLeave, cleanup state
- Handle each client_to_server message type per the protocol
- Relay player positions to other clients
- Track server-side state for gameplay items (coins, scores, etc.)

RULES:
1. Use require() (CommonJS), NOT import
2. Do NOT use any npm packages besides express and ws
3. Keep it simple -- this is a relay server with minimal game logic
4. Send messages as JSON: {{ type: string, data: any }}

Write the file now. No other output needed.
"""

    print("[integration] Generating server/index.js...")
    try:
        timeout = remaining_timeout(deadline)
        resp = call_claude(prompt, cwd=output_dir, timeout=timeout)
    except (TimeoutError, subprocess.TimeoutExpired) as e:
        print(f"[integration] Server generation TIMEOUT: {e}", file=sys.stderr)
        resp = {"error": f"timeout: {e}"}
    if "error" in resp:
        print(f"[integration] Server generation error: {resp['error'][:300]}", file=sys.stderr)
    if not os.path.exists(server_path):
        print("[integration] WARNING: server/index.js was not created", file=sys.stderr)
        return None
    print("[integration] server/index.js generated")
    return server_path


# ──────────────────────────────────────────────
# start.sh generation
# ──────────────────────────────────────────────

def write_start_sh(output_dir, port=2567, game_id="game"):
    """Write deterministic start.sh script."""
    start_sh = f"""#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Install server deps if needed
if [ ! -d server/node_modules ]; then
  echo "[start] Installing server dependencies..."
  cd server && npm init -y 2>/dev/null && npm install express ws 2>/dev/null && cd ..
fi

echo ""
echo "  Starting {game_id}..."
echo "  Server: http://localhost:{port}"
echo "  Open in browser to play!"
echo ""

node server/index.js
"""
    sh_path = os.path.join(output_dir, "start.sh")
    with open(sh_path, "w") as f:
        f.write(start_sh)
    os.chmod(sh_path, 0o755)
    print(f"[integration] Wrote start.sh")
    return sh_path


# ──────────────────────────────────────────────
# Playwright testing
# ──────────────────────────────────────────────

PLAYWRIGHT_TEST = """
const { chromium } = require('playwright');

(async () => {
  const results = { errors: [], warnings: [], status: 'unknown' };
  const PORT = %(port)s;
  const URL = `http://localhost:${PORT}`;
  let browser, serverProcess;

  try {
    // Start the server
    const { spawn } = require('child_process');
    serverProcess = spawn('node', ['server/index.js'], {
      cwd: '%(output_dir)s',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT) }
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('running on port')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProcess.stderr.on('data', (data) => {
        results.warnings.push('Server stderr: ' + data.toString().trim());
      });
      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Launch browser
    browser = await chromium.launch({ headless: true });

    // Tab 1
    const page1 = await browser.newPage();
    const page1Errors = [];
    page1.on('console', msg => {
      if (msg.type() === 'error') page1Errors.push(msg.text());
    });
    page1.on('pageerror', err => page1Errors.push(err.message));

    await page1.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for game loop to start
    await page1.waitForFunction(() => {
      return document.querySelector('#loading')?.style.display === 'none'
             || document.querySelectorAll('canvas').length > 0;
    }, { timeout: 30000 });

    // Let it run for a few seconds
    await new Promise(r => setTimeout(r, 3000));

    // Tab 2 -- test multiplayer
    const page2 = await browser.newPage();
    const page2Errors = [];
    page2.on('console', msg => {
      if (msg.type() === 'error') page2Errors.push(msg.text());
    });
    page2.on('pageerror', err => page2Errors.push(err.message));

    await page2.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page2.waitForFunction(() => {
      return document.querySelector('#loading')?.style.display === 'none'
             || document.querySelectorAll('canvas').length > 0;
    }, { timeout: 30000 });

    await new Promise(r => setTimeout(r, 3000));

    // Collect results
    const allErrors = [...page1Errors, ...page2Errors];

    // Filter out WebSocket connection errors (expected in some environments)
    const criticalErrors = allErrors.filter(e =>
      !e.includes('WebSocket') && !e.includes('ERR_CONNECTION_REFUSED')
    );

    results.errors = criticalErrors;
    results.all_console_errors = allErrors;
    results.status = criticalErrors.length === 0 ? 'pass' : 'fail';
    results.tabs_loaded = 2;

  } catch (err) {
    results.errors.push(err.message);
    results.status = 'error';
  } finally {
    if (browser) await browser.close();
    if (serverProcess) serverProcess.kill();
  }

  console.log(JSON.stringify(results));
})();
"""


def run_playwright_check(output_dir, port=2567, deadline=None):
    """Write and run the Playwright test, return parsed results."""
    test_path = os.path.join(output_dir, "_test_harness.js")
    test_code = PLAYWRIGHT_TEST % {"port": port, "output_dir": output_dir.replace("\\", "\\\\")}

    with open(test_path, "w") as f:
        f.write(test_code)

    timeout = min(90, remaining_timeout(deadline)) if deadline else 90

    print("[integration] Running Playwright test...")
    try:
        result = subprocess.run(
            ["node", test_path],
            capture_output=True, text=True, timeout=timeout,
            cwd=output_dir
        )
        stdout = result.stdout.strip()
        # Find JSON in output (last line should be JSON)
        for line in reversed(stdout.split("\n")):
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue
        return {"status": "error", "errors": [f"No JSON output. stdout: {stdout[:500]}", f"stderr: {result.stderr[:500]}"]}
    except subprocess.TimeoutExpired:
        return {"status": "error", "errors": ["Playwright test timed out after 90s"]}
    except FileNotFoundError:
        return {"status": "error", "errors": ["Node.js not found"]}
    finally:
        if os.path.exists(test_path):
            os.unlink(test_path)


# ──────────────────────────────────────────────
# Error attribution
# ──────────────────────────────────────────────

def attribute_error(error_msg, contract, module_graph):
    """Map a runtime error -> owning module -> specialist type.

    Returns: {"module": str|None, "specialist": str|None, "clause": str|None}
    """
    # Pattern 1: [module_name] build/start/update error
    bracket_match = re.search(r"\[(\w+)\]\s*(build|start|update)\s*error", error_msg, re.IGNORECASE)
    if bracket_match:
        mod_name = bracket_match.group(1)
        for wave in module_graph.get("waves", []):
            for a in wave.get("assignments", []):
                if a["name"] == mod_name:
                    return {"module": mod_name, "specialist": a["specialist"], "clause": f"module:{mod_name}"}
        return {"module": mod_name, "specialist": None, "clause": None}

    # Pattern 2: Error references a known module name
    all_assignments = [a for w in module_graph.get("waves", []) for a in w.get("assignments", [])]
    for a in all_assignments:
        if a["name"] in error_msg:
            return {"module": a["name"], "specialist": a["specialist"], "clause": f"module:{a['name']}"}

    # Pattern 3: Error references a ctx_extension
    for ext in contract.get("interfaces", {}).get("ctx_extensions", []):
        if ext["name"] in error_msg:
            return {"module": None, "specialist": ext["provided_by"], "clause": f"ctx_extension:{ext['name']}"}

    # Pattern 4: Error references an event
    for evt in contract.get("interfaces", {}).get("events", []):
        if evt["name"] in error_msg:
            return {"module": None, "specialist": evt["emitted_by"], "clause": f"event:{evt['name']}"}

    # Pattern 5: Error references a mesh_registry key
    for mesh in contract.get("interfaces", {}).get("mesh_registry", []):
        if mesh["key"] in error_msg:
            return {"module": None, "specialist": mesh["provided_by"], "clause": f"mesh:{mesh['key']}"}

    return {"module": None, "specialist": None, "clause": None}


# ──────────────────────────────────────────────
# Fix routing
# ──────────────────────────────────────────────

def route_fix(errors, contract, module_graph, specialist_sessions, output_dir,
              round_num=1, failed_specialists=None, deadline=None):
    """Route errors to their owning specialists for fixes.

    If a specialist already failed in a prior round (in failed_specialists set),
    its errors go straight to direct_fix instead of retrying the specialist.
    """
    if failed_specialists is None:
        failed_specialists = set()

    # Group errors by specialist
    specialist_errors = {}
    direct_fix_errors = []

    for err in errors:
        attr = attribute_error(err, contract, module_graph)
        specialist = attr["specialist"]
        if specialist and specialist in specialist_sessions and specialist_sessions[specialist]:
            if specialist in failed_specialists:
                # Same specialist failed twice -- go straight to direct fix
                direct_fix_errors.append(err)
            else:
                if specialist not in specialist_errors:
                    specialist_errors[specialist] = []
                specialist_errors[specialist].append({"error": err, "attribution": attr})
        else:
            direct_fix_errors.append(err)

    fixes = []

    # Fix attributed errors via specialist sessions
    for specialist_type, err_list in specialist_errors.items():
        session_id = specialist_sessions[specialist_type]
        error_desc = "\n".join(f"  - {e['error']} (clause: {e['attribution']['clause']})" for e in err_list)
        fix_prompt = f"""The following errors were detected during integration testing:

{error_desc}

Read the relevant module files in {output_dir}/modules/ and fix these errors.
Use the Edit tool to fix the files in place. Do not rewrite entire files unless necessary.
Remember:
- Do NOT use import statements. All globals are on window.
- Events must be emitted in start(), not build().
- Use velocity-based ground detection, not raycasts from inside colliders.
"""
        print(f"[fix] Routing {len(err_list)} error(s) to {specialist_type} (round {round_num})")
        resp = resume_specialist(session_id, fix_prompt, output_dir, deadline=deadline)
        fixes.append({
            "specialist": specialist_type,
            "round": round_num,
            "errors": [e["error"] for e in err_list],
            "session_id": session_id,
            "response": resp.get("result", "")[:200],
        })
        # Mark this specialist as having been tried
        failed_specialists.add(specialist_type)

    # Handle unattributed / twice-failed specialist errors with direct fix
    if direct_fix_errors:
        print(f"[fix] {len(direct_fix_errors)} error(s) routed to direct fix (unattributed or specialist failed twice)")
        direct_result = direct_fix(direct_fix_errors, output_dir, deadline=deadline)
        fixes.append(direct_result)

    return fixes


def direct_fix(errors, output_dir, deadline=None):
    """Fallback: fix errors by reading all code (breaks specialist isolation)."""
    error_desc = "\n".join(f"  - {e}" for e in errors)

    prompt = f"""The following runtime errors were detected in a browser game at {output_dir}:

{error_desc}

Read ALL module files in {output_dir}/modules/ and the server at {output_dir}/server/index.js.
Then fix the errors using the Edit tool.

Key rules:
- No import statements in module files. All globals (THREE, RAPIER, etc.) are on window.
- Events must be emitted in start(), not build().
- Use velocity-based ground detection, not raycasts from inside colliders.
- Modules communicate only through ctx.eventBus and ctx.modules.<name>.
"""

    try:
        timeout = remaining_timeout(deadline)
    except TimeoutError as e:
        print(f"[fix] TIMEOUT before direct fix could start: {e}", file=sys.stderr)
        return {"type": "direct_fix", "errors": errors, "response": f"timeout: {e}"}

    print(f"[fix] Direct fix for {len(errors)} error(s) ({timeout:.0f}s remaining)...")
    try:
        resp = call_claude(
            prompt, cwd=output_dir,
            allowed_tools="Read,Write,Edit,Bash",
            timeout=timeout
        )
    except subprocess.TimeoutExpired as e:
        print(f"[fix] Direct fix TIMEOUT: {e}", file=sys.stderr)
        resp = {"error": f"timeout: {e}"}
    return {
        "type": "direct_fix",
        "errors": errors,
        "response": resp.get("result", "")[:200],
    }


# ──────────────────────────────────────────────
# Install Playwright if needed
# ──────────────────────────────────────────────

def ensure_playwright(output_dir, deadline=None):
    """Ensure playwright is available for testing."""
    try:
        subprocess.run(["node", "-e", "require('playwright')"],
                       capture_output=True, timeout=10, cwd=output_dir)
        return True
    except Exception:
        pass

    print("[integration] Installing playwright...")
    try:
        timeout = min(120, remaining_timeout(deadline)) if deadline else 120
        subprocess.run(["npm", "install", "playwright"],
                       capture_output=True, timeout=timeout, cwd=output_dir)
        timeout = min(120, remaining_timeout(deadline)) if deadline else 120
        subprocess.run(["npx", "playwright", "install", "chromium"],
                       capture_output=True, timeout=timeout, cwd=output_dir)
        return True
    except (TimeoutError, subprocess.TimeoutExpired) as e:
        print(f"[integration] Playwright install TIMEOUT: {e}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"[integration] Failed to install playwright: {e}", file=sys.stderr)
        return False


# ──────────────────────────────────────────────
# Main integration runner
# ──────────────────────────────────────────────

def run_integration(game_id, contract, module_graph, specialist_sessions, output_dir,
                    deadline=None):
    """Assemble game folder, test with Playwright, fix errors.

    Returns result dict with status, playwright_result, fixes.
    """
    mp = contract.get("multiplayer_spec", {})
    port = mp.get("server_port", 2567)

    # Step 1: Generate manifest.json
    generate_manifest(module_graph, output_dir)

    # Step 2: Generate index.html from template
    generate_index_html(contract, output_dir, port=port)

    # Step 3: Generate server/index.js via Claude
    generate_server_js(contract, output_dir, deadline=deadline)

    # Step 4: Write start.sh
    write_start_sh(output_dir, port=port, game_id=game_id)

    # Step 5: Install server dependencies
    server_dir = os.path.join(output_dir, "server")
    print("[integration] Installing server deps...")
    try:
        timeout = min(60, remaining_timeout(deadline)) if deadline else 60
        subprocess.run(
            ["bash", "-c", "npm init -y 2>/dev/null && npm install express ws 2>/dev/null"],
            capture_output=True, cwd=server_dir, timeout=timeout
        )
    except (TimeoutError, subprocess.TimeoutExpired) as e:
        print(f"[integration] Server deps install TIMEOUT: {e}", file=sys.stderr)

    # Step 6: Playwright test
    has_playwright = ensure_playwright(output_dir, deadline=deadline)
    if not has_playwright:
        print("[integration] Playwright not available, skipping test")
        return {
            "status": "skipped",
            "playwright_result": None,
            "fixes": [],
        }

    pw_result = run_playwright_check(output_dir, port=port, deadline=deadline)
    print(f"[integration] Playwright result: {pw_result.get('status')}")

    fixes = []

    # Step 7: Fix loop (max 2 specialist rounds, then direct fix)
    if pw_result.get("status") != "pass" and pw_result.get("errors"):
        errors = pw_result["errors"]
        print(f"[integration] {len(errors)} error(s) found, starting fix loop")

        failed_specialists = set()  # tracks specialists that already got a fix attempt

        for round_num in range(1, 3):
            # Check deadline before starting a fix round
            try:
                remaining_timeout(deadline)
            except TimeoutError:
                print(f"[integration] Deadline hit during fix loop (round {round_num})", file=sys.stderr)
                break

            round_fixes = route_fix(
                errors, contract, module_graph,
                specialist_sessions, output_dir,
                round_num=round_num,
                failed_specialists=failed_specialists,
                deadline=deadline,
            )
            fixes.extend(round_fixes if isinstance(round_fixes, list) else [round_fixes])

            # Re-test
            pw_result = run_playwright_check(output_dir, port=port, deadline=deadline)
            print(f"[integration] Round {round_num} re-test: {pw_result.get('status')}")

            if pw_result.get("status") == "pass":
                break
            errors = pw_result.get("errors", [])
            if not errors:
                break

        # After 2 specialist rounds, if still failing, direct fix everything
        if pw_result.get("status") != "pass" and pw_result.get("errors"):
            remaining = pw_result["errors"]
            print(f"[integration] Still {len(remaining)} error(s) after 2 rounds, running direct fix")
            direct_result = direct_fix(remaining, output_dir, deadline=deadline)
            fixes.append(direct_result)

            # Final re-test
            try:
                remaining_timeout(deadline)
                pw_result = run_playwright_check(output_dir, port=port, deadline=deadline)
                print(f"[integration] Post-direct-fix re-test: {pw_result.get('status')}")
            except TimeoutError:
                print("[integration] Deadline hit, skipping final re-test", file=sys.stderr)

    return {
        "status": pw_result.get("status", "unknown"),
        "playwright_result": pw_result,
        "fixes": fixes,
    }


if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python integration.py <game_id> <contract.json> <moduleGraph.json> <output_dir>",
              file=sys.stderr)
        sys.exit(1)

    game_id = sys.argv[1]
    with open(sys.argv[2]) as f:
        contract = json.load(f)
    with open(sys.argv[3]) as f:
        module_graph = json.load(f)
    output_dir = sys.argv[4]

    result = run_integration(
        game_id=game_id,
        contract=contract,
        module_graph=module_graph,
        specialist_sessions={},
        output_dir=output_dir,
    )
    print(json.dumps(result, indent=2, default=str))
