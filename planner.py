#!/usr/bin/env python3
"""D1: Planner Agent -- prompt in, {contract, module_graph} out.

Usage:
    python planner.py "a coin platformer"
    python planner.py "top-down arena shooter" --game-id arena_shooter
"""
import subprocess, json, sys, os, re, time

HARNESS_SPEC = """
IGameModule interface:
  export default class ModuleName {
    name = 'module_name';
    async build(ctx) { }   // Setup: create meshes, physics bodies, event listeners
    start() { }            // Called after ALL modules are built
    update(dt) { }         // Called every frame, dt in seconds
    dispose() { }          // Cleanup
  }

GameContext (ctx) shape:
  scene             // THREE.Scene
  camera            // THREE.PerspectiveCamera
  rapierWorld       // RAPIER.World
  RAPIER            // Rapier module
  gameConfig        // { worldWidth, worldDepth, gravity }
  meshRegistry      // Map<string, THREE.Mesh>
  eventBus          // EventTarget (CustomEvent with detail)
  uiOverlay         // <div> DOM overlay for HUD
  composer          // EffectComposer (has bloom)
  sunLight          // DirectionalLight (in scene)
  hemiLight         // HemisphereLight (in scene)
  getTerrainHeight  // (x,z) => y (set by environment module)
  wsUrl             // string e.g. "ws://localhost:2567"
  modules: {}       // populated as modules load

Globals available (no imports): THREE, RAPIER, GLTFLoader, EffectComposer, UnrealBloomPass, ColyseusClient
Network: ctx.modules.network.send(type, payload), ctx.modules.network.onMessage(type, cb), ctx.modules.network.getSessionId()
EventBus: ctx.eventBus.dispatchEvent(new CustomEvent('name', {detail: payload}))
"""


def call_claude(prompt, cwd=None, allowed_tools="Write,Read,Edit,Bash", timeout=180):
    """Invoke claude -p and return parsed JSON response."""
    if timeout is not None:
        m, s = int(timeout // 60), int(timeout % 60)
        prompt = f"[TIME BUDGET: {m}m{s}s — you will be killed after this. Finish all writes before time runs out. Prioritize correctness over polish.]\n\n{prompt}"

    cmd = [
        "claude", "-p", prompt,
        "--output-format", "json",
        "--allowedTools", allowed_tools,
    ]
    t0 = time.time()
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    duration = time.time() - t0
    if result.returncode != 0:
        print(f"[planner] claude exited with code {result.returncode}", file=sys.stderr)
        print(result.stderr[:2000], file=sys.stderr)
        return {"error": result.stderr, "duration_s": duration}
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


def build_planner_prompt(game_prompt, game_id, contract_path, graph_path):
    return f"""You are a game architect designing a multiplayer browser game.

GAME PROMPT: "{game_prompt}"
GAME ID: "{game_id}"

You must produce TWO JSON files using the Write tool.

=== FILE 1: {contract_path} ===
A complete interface contract with these REQUIRED sections:

{{
  "game_id": "{game_id}",
  "prompt": "{game_prompt}",

  "interfaces": {{
    "ctx_extensions": [
      // Functions/objects set on ctx. Each entry:
      // {{ "name", "signature", "description", "set_on", "provided_by": "<specialist_type>", "consumed_by": ["<specialist_type>", ...] }}
    ],
    "events": [
      // EventBus events. Each entry:
      // {{ "name", "payload": "<TypeScript-style shape>", "emitted_by": "<specialist_type>", "consumed_by": ["<specialist_type>", ...] }}
    ],
    "mesh_registry": [
      // Shared meshes. Each entry:
      // {{ "key", "description", "provided_by": "<specialist_type>" }}
    ]
  }},

  "network_protocol": {{
    "client_to_server": [
      // {{ "type": "<message_type>", "payload": "<shape>" }}
    ],
    "server_to_client": [
      // MUST include: __sessionId, gameState, playerJoined, playerLeave
      // {{ "type": "<message_type>", "payload": "<shape>" }}
    ]
  }},

  "gameplay_spec": {{
    // win_condition, total items, player_config (speed, jump, spawn), collectible_config etc.
  }},

  "multiplayer_spec": {{
    "max_players": 4,
    "sync_rate_hz": 20,
    "singleplayer_fallback": true,
    "server_port": 2567
  }},

  "visual_spec": {{
    // sky_color, fog_color, fog_near, fog_far, sun_color, sun_intensity, bloom settings
  }},

  "contract_warnings": [
    // Any conflicts or edge cases that couldn't be auto-resolved
  ]
}}

=== FILE 2: {graph_path} ===
A wave-structured module dependency graph:

{{
  "game_id": "{game_id}",
  "waves": [
    {{
      "wave": "A",
      "assignments": [
        {{
          "name": "<module_name>",
          "specialist": "<specialist_type>",
          "depends_on": [],
          "specialist_description": "<paragraph scoping this specialist's domain, including what it must provide/consume from the contract>"
        }}
      ]
    }},
    {{
      "wave": "B",
      "assignments": [
        // Modules that depend on Wave A outputs
      ]
    }}
  ]
}}

=== RULES ===
1. Network is ALWAYS its own specialist, always in Wave A.
2. Specialist types are INVENTED per prompt -- not from a fixed menu. A racing game needs different specialists than a platformer.
3. Complex prompts should produce MORE specialists and modules. Simple prompts can have fewer.
4. Every ctx_extension must have exactly one provided_by and at least one consumed_by.
5. Every event must have exactly one emitted_by and at least one consumed_by.
6. Wave A: modules with depends_on=[]. Wave B: modules depending on Wave A.
7. specialist_description must be detailed enough for an isolated agent to implement the module.
8. The network specialist MUST expose: send(type, payload), onMessage(type, cb), getSessionId().
9. The network specialist MUST implement singleplayer fallback when server is unavailable.
10. Events emitted in build() are LOST if listener module hasn't built yet. Informational events go in start().
11. Include the player module's getPosition() as a ctx_extension for gameplay modules to check proximity.
12. server_to_client MUST include: __sessionId, gameState, playerJoined, playerLeave.

=== HARNESS REFERENCE ===
{HARNESS_SPEC}

Write ONLY the two JSON files. No other output needed.
"""


def validate_contract(contract, module_graph):
    """Return list of validation errors (empty = valid)."""
    errors = []
    required_keys = ["game_id", "interfaces", "network_protocol", "gameplay_spec", "multiplayer_spec", "visual_spec"]
    for k in required_keys:
        if k not in contract:
            errors.append(f"Missing top-level key: {k}")

    ifaces = contract.get("interfaces", {})
    for section in ["ctx_extensions", "events", "mesh_registry"]:
        if section not in ifaces:
            errors.append(f"Missing interfaces.{section}")

    # Check network protocol baseline
    proto = contract.get("network_protocol", {})
    s2c_types = {m["type"] for m in proto.get("server_to_client", [])}
    for required in ["__sessionId", "playerJoined", "playerLeave"]:
        if required not in s2c_types:
            errors.append(f"Missing server_to_client type: {required}")

    # Check singleplayer fallback
    mp = contract.get("multiplayer_spec", {})
    if not mp.get("singleplayer_fallback"):
        errors.append("multiplayer_spec.singleplayer_fallback must be true")

    # Check module_graph has waves
    waves = module_graph.get("waves", [])
    if len(waves) < 1:
        errors.append("module_graph must have at least 1 wave")

    # Check all specialists have descriptions
    for wave in waves:
        for a in wave.get("assignments", []):
            if not a.get("specialist_description"):
                errors.append(f"Missing specialist_description for {a.get('name')}")

    # Check network specialist exists
    all_specialists = {a["specialist"] for w in waves for a in w.get("assignments", [])}
    if "network" not in all_specialists:
        errors.append("No network specialist found")

    return errors


def run_planner(game_prompt, game_id, base_dir=".", deadline=None):
    """Run the planner agent. Returns (contract, module_graph) dicts."""
    workspace_dir = os.path.join(base_dir, "workspace", game_id)
    os.makedirs(workspace_dir, exist_ok=True)

    contract_path = os.path.join(workspace_dir, "contract.json")
    graph_path = os.path.join(workspace_dir, "moduleGraph.json")

    prompt = build_planner_prompt(game_prompt, game_id, contract_path, graph_path)
    print(f"[planner] Generating contract for: {game_prompt}")

    timeout = 120
    if deadline is not None:
        timeout = deadline - time.time()
        if timeout <= 0:
            raise TimeoutError(f"Pipeline deadline exceeded before planner started")

    resp = call_claude(prompt, cwd=base_dir, timeout=timeout)
    if "error" in resp:
        raise RuntimeError(f"Planner failed: {resp['error'][:500]}")

    print(f"[planner] Done in {resp['duration_s']:.1f}s")

    # Read generated files
    if not os.path.exists(contract_path):
        raise RuntimeError(f"Planner did not write {contract_path}")
    if not os.path.exists(graph_path):
        raise RuntimeError(f"Planner did not write {graph_path}")

    with open(contract_path) as f:
        contract = json.load(f)
    with open(graph_path) as f:
        module_graph = json.load(f)

    # Validate
    errs = validate_contract(contract, module_graph)
    if errs:
        print(f"[planner] Validation warnings: {errs}", file=sys.stderr)

    return {
        "contract": contract,
        "module_graph": module_graph,
        "session_id": resp.get("session_id"),
        "duration_s": resp["duration_s"],
    }


def slugify(text):
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s-]+", "_", text)
    return text[:40]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python planner.py \"game prompt\" [--game-id ID]", file=sys.stderr)
        sys.exit(1)

    prompt = sys.argv[1]
    gid = None
    if "--game-id" in sys.argv:
        idx = sys.argv.index("--game-id")
        gid = sys.argv[idx + 1]
    if not gid:
        gid = slugify(prompt)

    result = run_planner(prompt, gid)
    print(json.dumps(result["contract"], indent=2))
