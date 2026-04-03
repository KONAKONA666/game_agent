#!/usr/bin/env python3
"""D2: Specialist Runner -- generic runner for any specialist type.

Usage (standalone):
    python specialist.py <config.json> <output_dir>

Config JSON shape:
    { "specialist_type", "specialist_description", "assigned_modules": [...],
      "contract": {...}, "game_id": "..." }
"""
import subprocess, json, sys, os, time

PIPELINE_BUDGET = 600  # seconds (10 minutes)


def remaining_timeout(deadline):
    """Return seconds left until deadline. Raises TimeoutError if expired."""
    if deadline is None:
        return None
    left = deadline - time.time()
    if left <= 0:
        raise TimeoutError(f"Pipeline deadline exceeded ({-left:.0f}s over budget)")
    return left


HARNESS_SPEC = """
## Module Interface (IGameModule)
Every module file must export a default class:

```js
export default class ModuleName {
  name = 'module_name';       // MUST match the module name in the manifest
  async build(ctx) { }        // Setup: create meshes, physics bodies, register event listeners
  start() { }                 // Called AFTER all modules have built -- emit informational events here
  update(dt) { }              // Called every frame, dt = delta time in seconds (capped at 0.05)
  dispose() { }               // Cleanup: remove meshes, listeners, physics bodies
}
```

## GameContext (ctx) -- passed to build()
```
ctx.scene             // THREE.Scene (already has lights, fog, sky)
ctx.camera            // THREE.PerspectiveCamera
ctx.rapierWorld       // RAPIER.World (gravity set to {x:0, y:-30, z:0})
ctx.RAPIER            // Rapier module (also on window.RAPIER)
ctx.gameConfig        // { worldWidth: 100, worldDepth: 100, gravity: -30 }
ctx.meshRegistry      // Map<string, THREE.Mesh>
ctx.eventBus          // EventTarget -- use CustomEvent with {detail: payload}
ctx.uiOverlay         // <div> full-screen overlay with pointer-events:none
ctx.composer          // EffectComposer (has bloom pass)
ctx.sunLight          // DirectionalLight (in scene, shadow-enabled)
ctx.hemiLight         // HemisphereLight (in scene)
ctx.getTerrainHeight  // (x, z) => y -- set by environment module
ctx.wsUrl             // WebSocket URL string
ctx.modules           // {module_name: instance} -- populated as modules load
```

## Globals (on window -- do NOT import)
THREE, RAPIER, GLTFLoader, EffectComposer, UnrealBloomPass, ColyseusClient

## EventBus Usage
  Emit:   ctx.eventBus.dispatchEvent(new CustomEvent('event:name', { detail: payload }))
  Listen: ctx.eventBus.addEventListener('event:name', (e) => { const data = e.detail; })

## Network (via ctx.modules.network -- available after network module builds)
  ctx.modules.network.send(type, payload)       // Send to server
  ctx.modules.network.onMessage(type, callback)  // Listen for server messages
  ctx.modules.network.getSessionId()             // Local player session ID

## ColyseusClient (harness-provided WebSocket wrapper)
  const client = new ColyseusClient(ctx.wsUrl);
  const room = await client.joinOrCreate('game');
  room.send(type, payload);
  room.onMessage(type, callback);
  room.sessionId;  // set after __sessionId message from server
"""


def call_claude(prompt, cwd=None, allowed_tools="Write,Read,Edit,Bash",
                timeout=180, resume_session=None):
    """Invoke claude -p and return parsed JSON response."""
    if timeout is not None:
        m, s = int(timeout // 60), int(timeout % 60)
        prompt = f"[TIME BUDGET: {m}m{s}s — you will be killed after this. Finish all writes before time runs out. Prioritize correctness over polish.]\n\n{prompt}"

    cmd = [
        "claude", "-p", prompt,
        "--output-format", "json",
        "--allowedTools", allowed_tools,
    ]
    if resume_session:
        cmd.extend(["--resume", resume_session])
    t0 = time.time()
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    duration = time.time() - t0
    if result.returncode != 0:
        return {"error": result.stderr[:2000], "duration_s": duration, "session_id": None}
    try:
        resp = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"result": result.stdout, "session_id": None, "duration_s": duration}
    return {
        "result": resp.get("result", ""),
        "session_id": resp.get("session_id"),
        "duration_s": duration,
        "is_error": resp.get("is_error", False),
    }


def scope_contract(contract, specialist_type, module_names):
    """Extract contract clauses relevant to this specialist."""
    scoped = {
        "game_id": contract.get("game_id"),
        "interfaces": {"ctx_extensions": [], "events": [], "mesh_registry": []},
        "network_protocol": contract.get("network_protocol", {}),
        "gameplay_spec": contract.get("gameplay_spec", {}),
        "multiplayer_spec": contract.get("multiplayer_spec", {}),
        "visual_spec": contract.get("visual_spec", {}),
        "contract_warnings": contract.get("contract_warnings", []),
    }
    names_set = set(module_names)
    names_set.add(specialist_type)

    for ext in contract.get("interfaces", {}).get("ctx_extensions", []):
        if ext.get("provided_by") == specialist_type or ext.get("provided_by") in names_set:
            scoped["interfaces"]["ctx_extensions"].append(ext)
        elif names_set & set(ext.get("consumed_by", [])):
            scoped["interfaces"]["ctx_extensions"].append(ext)

    for evt in contract.get("interfaces", {}).get("events", []):
        if evt.get("emitted_by") == specialist_type or evt.get("emitted_by") in names_set:
            scoped["interfaces"]["events"].append(evt)
        elif names_set & set(evt.get("consumed_by", [])):
            scoped["interfaces"]["events"].append(evt)

    for mesh in contract.get("interfaces", {}).get("mesh_registry", []):
        if mesh.get("provided_by") == specialist_type or mesh.get("provided_by") in names_set:
            scoped["interfaces"]["mesh_registry"].append(mesh)

    return scoped


def build_specialist_prompt(specialist_type, specialist_description, assigned_modules, contract, output_dir):
    """Build the prompt for this specialist's claude -p call."""
    scoped = scope_contract(contract, specialist_type, assigned_modules)
    module_files = "\n".join(
        f"  - {output_dir}/modules/{m}.js" for m in assigned_modules
    )

    network_addendum = ""
    if specialist_type == "network":
        network_addendum = """
NETWORK SPECIALIST -- ADDITIONAL REQUIREMENTS:
- You MUST expose these methods on the module instance:
    send(type, payload)     -- send message to server (no-op if disconnected)
    onMessage(type, cb)     -- register handler for server message type
    getSessionId()          -- return local session ID string
- You MUST implement singleplayer fallback: if WebSocket connection fails,
  generate a local 'solo_xxx' session ID, make send() a no-op, and still emit
  'network:connected' so the game works offline.
- Use: const client = new ColyseusClient(ctx.wsUrl); const room = await client.joinOrCreate('game');
- Forward playerJoined/playerLeave messages to eventBus as 'network:playerJoined'/'network:playerLeft'.
- Emit 'network:connected' in start(), NOT in build(), so all listener modules are ready.
"""

    return f"""You are a {specialist_type} specialist for a multiplayer browser game.

SPECIALIST SCOPE: {specialist_description}

ASSIGNED MODULES: {', '.join(assigned_modules)}

Write the following module files using the Write tool:
{module_files}

Create the modules/ directory first if it doesn't exist (use Bash: mkdir -p modules).

{HARNESS_SPEC}

=== YOUR CONTRACT CLAUSES ===
{json.dumps(scoped, indent=2)}

=== RULES ===
1. Each module is a single .js file with: export default class {{ name = '...'; build(ctx){{}} start(){{}} update(dt){{}} dispose(){{}} }}
2. Do NOT use import statements. All globals (THREE, RAPIER, etc.) are on window.
3. Access other modules ONLY through ctx.modules.<name> -- never import them.
4. You MUST provide every ctx_extension where provided_by is "{specialist_type}".
5. You MUST emit every event where emitted_by is "{specialist_type}".
6. You MUST register every mesh_registry entry where provided_by is "{specialist_type}".
7. You MAY consume (read) ctx_extensions/events where your specialist appears in consumed_by.
8. NEVER emit events in build() -- use start() for informational events (timing issue with listener registration).
9. For physics: use ctx.RAPIER (e.g., ctx.RAPIER.RigidBodyDesc.dynamic(), ctx.RAPIER.ColliderDesc.capsule()).
10. For jump/ground checks: use velocity-based detection (Math.abs(vel.y) < threshold) with cooldown. Do NOT raycast from inside the player collider.
11. Keep code simple and working. This is a demo game.
{network_addendum}
Write each module file now. No other output needed.
"""


def run_specialist(specialist_type, specialist_description, assigned_modules,
                   contract, game_id, output_dir, deadline=None):
    """Run the specialist agent. Returns result dict with session_id."""
    os.makedirs(os.path.join(output_dir, "modules"), exist_ok=True)

    prompt = build_specialist_prompt(
        specialist_type, specialist_description, assigned_modules,
        contract, output_dir
    )
    print(f"[{specialist_type}] Building {assigned_modules}...")
    t_start = time.time()

    try:
        timeout = remaining_timeout(deadline)
        resp = call_claude(prompt, cwd=output_dir, timeout=timeout)
    except (TimeoutError, subprocess.TimeoutExpired) as e:
        print(f"[{specialist_type}] TIMEOUT: {e}", file=sys.stderr)
        resp = {"error": f"timeout: {e}", "session_id": None}

    t_end = time.time()

    if "error" in resp:
        print(f"[{specialist_type}] ERROR: {resp['error'][:300]}", file=sys.stderr)

    # Verify output files
    produced = {}
    missing = []
    for mod_name in assigned_modules:
        fpath = os.path.join(output_dir, "modules", f"{mod_name}.js")
        if os.path.exists(fpath):
            with open(fpath) as f:
                produced[mod_name] = f.read()
        else:
            missing.append(mod_name)

    if missing:
        print(f"[{specialist_type}] Missing modules: {missing}", file=sys.stderr)

    duration = t_end - t_start
    print(f"[{specialist_type}] Done in {duration:.1f}s -- produced {list(produced.keys())}")

    return {
        "specialist_type": specialist_type,
        "session_id": resp.get("session_id"),
        "modules": produced,
        "missing": missing,
        "started_at": t_start,
        "ended_at": t_end,
        "duration_s": duration,
    }


def resume_specialist(session_id, fix_prompt, output_dir, deadline=None):
    """Resume a specialist session with a fix prompt."""
    print(f"[fix] Resuming session {session_id[:12]}...")
    try:
        timeout = remaining_timeout(deadline)
        resp = call_claude(
            fix_prompt, cwd=output_dir,
            allowed_tools="Read,Write,Edit,Bash",
            timeout=timeout, resume_session=session_id
        )
    except (TimeoutError, subprocess.TimeoutExpired) as e:
        print(f"[fix] TIMEOUT resuming {session_id[:12]}: {e}", file=sys.stderr)
        resp = {"error": f"timeout: {e}", "session_id": session_id}
    return resp


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python specialist.py <config.json> <output_dir>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1]) as f:
        config = json.load(f)
    output_dir = sys.argv[2]

    result = run_specialist(
        specialist_type=config["specialist_type"],
        specialist_description=config["specialist_description"],
        assigned_modules=config["assigned_modules"],
        contract=config["contract"],
        game_id=config["game_id"],
        output_dir=output_dir,
    )
    print(json.dumps({k: v for k, v in result.items() if k != "modules"}, indent=2))
