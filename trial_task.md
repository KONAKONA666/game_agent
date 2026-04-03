# Parallel Coding Agents Architecture

# Parallel Subagent Game Generation Pipeline

Roam's current codegen uses a single agent that writes all game modules sequentially -- it sees everything it's written and wires things up with full context. This works, but it's slow and serial.

This task builds an alternative: a swarm of specialist agents that each only see a shared interface contract, build their modules in parallel, and get assembled into a working multiplayer game. The interesting problems are in contract design (how do isolated agents agree on interfaces before writing code?), failure attribution (which agent broke the game?), and actually hitting the timing target through real parallelism.

**Constraint:** Standalone system -- no modifications to existing codegen. Uses Three.js + Rapier.

The runtime is browser-based 3D using [Three.js](https://threejs.org/docs/) (scene graph, rendering, cameras, lights) and [Rapier](https://rapier.rs/docs/user_guides/javascript/getting_started) (physics engine -- rigid bodies, colliders, forces). Multiplayer uses [Colyseus](https://docs.colyseus.io/) as a lightweight relay server. You don't need deep expertise in any of these -- the harness handles setup. Your agents produce modules that plug into it. Spend time with the Three.js fundamentals guide and the Rapier JS docs to understand the `ctx` shape below.

```
INPUT:  "a third-person platformer where you collect coins"
OUTPUT: output/{game_id}/
        ├── index.html
        ├── modules/
        ├── manifest.json
        ├── server/           # Colyseus relay
        ├── start.sh          # one command: server + browser
        ├── contract.json
        └── trace.json

ACCEPTANCE: bash start.sh -> open two browser tabs -> play
```

---

## Architecture

```
                       [PROMPT]
                           |
                           v
             +---------------------------+
             |       PLANNER AGENT       |
             |  -> ModuleGraph (waves)   |
             |  -> contract.json         |
             +---------------------------+
                           |
                   contract.json
                           |
    +----------+-----------+----------+-----------+
    v          v           v          v           v
 [SPEC-A]  [SPEC-B]   [SPEC-C]   [SPEC-D]   [SPEC-E]
    |          |           |          |           |
    v          v           v          v           v
 mod_1.js  mod_2.js   mod_3.js   mod_4.js    mod_5.js
    |          |           |          |           |
    +----------+-----------+----------+-----------+
                           |
                           v
             +---------------------------+
             |    INTEGRATION AGENT      |
             |  assembles game folder    |
             |  generates Colyseus       |
             |  runtime check            |
             |  error attribution        |
             +---------------------------+
                           |
                           v
                  playable multiplayer game
```

Subagents cannot see each other's code. They build against the contract only.

---

## Phase 1: Planning

Planner takes raw prompt, produces:

**ModuleGraph** -- wave-structured dependency plan:

```json
{
  "waves": [
    {
      "wave": "A",
      "assignments": [
        { "name": "environment", "specialist": "environment", "depends_on": [] },
        { "name": "ui", "specialist": "ui", "depends_on": [] },
        { "name": "network", "specialist": "network", "depends_on": [] }
      ]
    },
    {
      "wave": "B",
      "assignments": [
        { "name": "player", "specialist": "physics_player", "depends_on": ["environment", "network"] },
        { "name": "gameplay", "specialist": "gameplay", "depends_on": ["network"] }
      ]
    }
  ]
}
```

**contract.json** -- shared interface every subagent honors. Must contain:

- `interfaces.ctx_extensions[]` -- functions/objects on ctx, each with `provided_by` + `consumed_by`
- `interfaces.events[]` -- eventBus events, each with payload shape, `emitted_by` + `consumed_by`
- `interfaces.mesh_registry[]` -- shared meshes
- `network_protocol.client_to_server[]` and `server_to_client[]` -- message types with payload shapes
- `gameplay_spec` -- win/fail conditions, collectibles, player config
- `multiplayer_spec` -- max players, sync rate, singleplayer fallback flag
- `visual_spec` -- sky, fog, lighting, bloom

Planner invents specialist types per prompt (not from a fixed menu). Network is always its own specialist. Each specialist gets a `specialist_description` paragraph scoping its domain.

Conflicts the Planner can't auto-resolve go in `contract_warnings[]`.

---

## Phase 2: Parallel Build

Orchestrator reads ModuleGraph, launches Wave A concurrently, launches Wave B as dependencies complete.

Each subagent receives:

- Its `specialist_description` + assigned module names
- The full contract
- Harness environment spec (GameContext shape, IGameModule interface)

Each subagent does NOT receive other subagents' code.

One generic runner (`specialist.py`) handles all specialist types. No hardcoded branches per type.

---

## Phase 3: Integration

Integration agent assembles the game folder:

- `index.html` from harness template with injected `wsUrl` + manifest path
- `manifest.json` with correct load order
- `server/index.js` generated from `contract.network_protocol`
- `start.sh` that starts Colyseus + prints URL

Runtime check via Playwright headless. On errors:

- Attributes each error to owning specialist using contract definitions
- Routes fix back to that specialist (max 2 rounds)
- Fixes directly after round 2, or if same specialist failed twice

---

## Module Interface

Every module conforms to `IGameModule`:

```jsx
export default class ModuleName {
  name = 'module_name';
  async build(ctx) { }
  start() { }
  update(dt) { }
  dispose() { }
}
```

GameContext (`ctx`) shape:

```jsx
{
  scene,             // THREE.Scene
  camera,            // THREE.PerspectiveCamera
  rapierWorld,       // RAPIER.World
  RAPIER,
  gameConfig,        // { worldWidth, worldDepth, gravity }
  meshRegistry,      // Map<string, THREE.Mesh>
  eventBus,          // EventTarget
  uiOverlay,        // <div>
  composer,          // EffectComposer
  sunLight,          // DirectionalLight
  hemiLight,         // HemisphereLight
  getTerrainHeight,  // (x,z) => y
  wsUrl,             // string
  modules: {}
}
```

Globals available (no imports): `THREE`, `RAPIER`, `GLTFLoader`, `EffectComposer`, `UnrealBloomPass`, `ColyseusClient`

All network comms go through `ctx.modules.network.send()` and `ctx.modules.network.onMessage()`.

---

## Deliverables

### D1: Planner Agent

`planner.py` -- prompt in, `{ module_graph, contract }` out.

- Contract passes JSON schema validation
- Specialist types invented per prompt, not fixed
- Network always its own specialist
- Complex prompts produce more specialists/modules than simple ones
- Callable standalone: `python planner.py "a coin platformer"` prints contract

### D2: Specialist Runner

`specialist.py` -- generic runner for any specialist type.

Input: `{ specialist_type, specialist_description, assigned_modules, contract, harness_spec }`
Output: `{ specialist_type, modules: { name: code }, iterations, duration_s, trace }`

- Same runner handles 2-module and 6-module specialists
- Scopes system prompt to only the contract clauses the specialist owns
- Network specialist exposes `send(type, payload)` + `onMessage(type, cb)` + singleplayer fallback

### D3: Orchestrator

`orchestrator.py` -- runs the full pipeline.

- Phase 1: calls Planner, validates, writes contract
- Phase 2: launches Wave A concurrently, Wave B after dependencies
- Phase 3: calls Integration agent
- Writes `trace.json` with per-agent `{ started_at, ended_at, duration_s, modules_produced }`
- Wave A trace entries must show overlapping timestamps (proof of parallelism)
- Total <= 10 minutes

### D4: Integration Agent

`integration.py` -- assembles game folder, generates Colyseus server, runs check, routes failures.

- Writes index.html, manifest.json, server/index.js, [start.sh](http://start.sh/)
- Playwright headless check: game loads, second client connects
- Error attribution cites contract clause
- Singleplayer fallback works when server killed mid-session

### D5: Demos

Run three prompts, commit full output folders.

| # | Prompt | Verify |
| --- | --- | --- |
| 1 | "third-person platformer, collect coins on floating islands" | Two tabs, coin collection syncs score via server |
| 2 | "top-down arena shooter, players shoot each other for points" | Projectile hit registers across tabs |
| 3 | "racing game, compete through checkpoints" | Checkpoint progress syncs, singleplayer fallback on server kill |

Each: `bash start.sh` -> playable in two browser tabs. No build step.

### D6: Design Notes

README bullets:

- What class of prompt produces a bad contract, and how to fix it
- What breaks when a module deviates from network protocol vs a bad contract
- What degrades the 10-min target most in practice
- How to support human editing of contract.json before subagents run

---

## Setup Provided

- Harness `index.html` template with `<!-- INJECT_MANIFEST_PATH -->` and `<!-- INJECT_WS_URL -->`
- `IGameModule` interface + `GameContext` shape reference doc
- Globals list
- Colyseus room template (skeleton with blank handlers)
- One sample `contract.json`
- Colyseus + Node.js pre-installed