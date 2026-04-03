#!/usr/bin/env python3
"""D3: Orchestrator -- runs the full pipeline.

Usage:
    python orchestrator.py "third-person platformer, collect coins on floating islands"
    python orchestrator.py "top-down arena shooter" --game-id arena
"""
import json, sys, os, re, time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

from planner import run_planner, slugify
from specialist import run_specialist, PIPELINE_BUDGET
from integration import run_integration


def run_pipeline(game_prompt, game_id=None):
    """Execute the full planner -> parallel build -> integration pipeline."""
    pipeline_start = time.time()
    deadline = pipeline_start + PIPELINE_BUDGET

    if not game_id:
        game_id = slugify(game_prompt)
    base_dir = os.path.dirname(os.path.abspath(__file__))
    output_dir = os.path.join(base_dir, "output", game_id)
    os.makedirs(os.path.join(output_dir, "modules"), exist_ok=True)
    os.makedirs(os.path.join(output_dir, "server"), exist_ok=True)

    trace = {
        "game_id": game_id,
        "prompt": game_prompt,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "phases": {},
    }

    try:
        # ──────────────────────────────────────────────
        # Phase 1: Planning
        # ──────────────────────────────────────────────
        print("\n=== PHASE 1: PLANNING ===")
        p1_start = time.time()
        plan = run_planner(game_prompt, game_id, base_dir, deadline=deadline)
        p1_end = time.time()

        contract = plan["contract"]
        module_graph = plan["module_graph"]

        trace["phases"]["planning"] = {
            "started_at": p1_start,
            "ended_at": p1_end,
            "duration_s": round(p1_end - p1_start, 2),
            "modules": [
                a["name"]
                for w in module_graph["waves"]
                for a in w["assignments"]
            ],
            "waves": len(module_graph["waves"]),
            "specialists": list({
                a["specialist"]
                for w in module_graph["waves"]
                for a in w["assignments"]
            }),
        }

        print(f"[orchestrator] Contract generated: {len(contract.get('interfaces', {}).get('ctx_extensions', []))} ctx_extensions, "
              f"{len(contract.get('interfaces', {}).get('events', []))} events")
        print(f"[orchestrator] Module graph: {len(module_graph['waves'])} waves, "
              f"{sum(len(w['assignments']) for w in module_graph['waves'])} modules")

        # ──────────────────────────────────────────────
        # Phase 2: Parallel Build
        # ──────────────────────────────────────────────
        print("\n=== PHASE 2: PARALLEL BUILD ===")
        specialist_sessions = {}  # specialist_type -> session_id
        specialist_results = {}   # specialist_type -> result dict
        trace["phases"]["parallel_build"] = {}

        for wave in module_graph["waves"]:
            wave_name = wave["wave"]
            assignments = wave["assignments"]

            # Group assignments by specialist type
            specialists_in_wave = {}
            for a in assignments:
                st = a["specialist"]
                if st not in specialists_in_wave:
                    specialists_in_wave[st] = {
                        "type": st,
                        "description": a.get("specialist_description", ""),
                        "modules": [],
                    }
                specialists_in_wave[st]["modules"].append(a["name"])

            print(f"\n--- Wave {wave_name}: {list(specialists_in_wave.keys())} ---")
            wave_trace = {"agents": [], "parallel": True}

            # Launch all specialists in this wave concurrently
            with ThreadPoolExecutor(max_workers=len(specialists_in_wave)) as pool:
                futures = {}
                for st, spec in specialists_in_wave.items():
                    future = pool.submit(
                        run_specialist,
                        specialist_type=spec["type"],
                        specialist_description=spec["description"],
                        assigned_modules=spec["modules"],
                        contract=contract,
                        game_id=game_id,
                        output_dir=output_dir,
                        deadline=deadline,
                    )
                    futures[future] = st

                for future in as_completed(futures):
                    st = futures[future]
                    try:
                        result = future.result()
                    except Exception as e:
                        print(f"[{st}] EXCEPTION: {e}", file=sys.stderr)
                        result = {"specialist_type": st, "error": str(e),
                                  "session_id": None, "started_at": 0, "ended_at": 0,
                                  "duration_s": 0, "modules": {}, "missing": []}

                    specialist_results[st] = result
                    specialist_sessions[st] = result.get("session_id")

                    wave_trace["agents"].append({
                        "specialist": st,
                        "started_at": result.get("started_at", 0),
                        "ended_at": result.get("ended_at", 0),
                        "duration_s": round(result.get("duration_s", 0), 2),
                        "modules_produced": list(result.get("modules", {}).keys()),
                        "missing": result.get("missing", []),
                    })

            trace["phases"]["parallel_build"][f"wave_{wave_name}"] = wave_trace

        # Verify all modules exist
        all_modules = [a["name"] for w in module_graph["waves"] for a in w["assignments"]]
        missing = [m for m in all_modules
                   if not os.path.exists(os.path.join(output_dir, "modules", f"{m}.js"))]
        if missing:
            print(f"\n[orchestrator] WARNING: Missing modules after build: {missing}", file=sys.stderr)

        # ──────────────────────────────────────────────
        # Phase 3: Integration
        # ──────────────────────────────────────────────
        print("\n=== PHASE 3: INTEGRATION ===")
        p3_start = time.time()

        integration_result = run_integration(
            game_id=game_id,
            contract=contract,
            module_graph=module_graph,
            specialist_sessions=specialist_sessions,
            output_dir=output_dir,
            deadline=deadline,
        )
        p3_end = time.time()

        trace["phases"]["integration"] = {
            "started_at": p3_start,
            "ended_at": p3_end,
            "duration_s": round(p3_end - p3_start, 2),
            "status": integration_result.get("status", "unknown"),
            "playwright_result": integration_result.get("playwright_result"),
            "fixes": integration_result.get("fixes", []),
        }

    except TimeoutError as e:
        print(f"\n=== PIPELINE TIMEOUT: {e} ===", file=sys.stderr)
        trace["timeout"] = True
        trace["timeout_error"] = str(e)

    # Write trace.json (always, even on timeout)
    pipeline_end = time.time()
    trace["total_duration_s"] = round(pipeline_end - pipeline_start, 2)
    trace_path = os.path.join(output_dir, "trace.json")
    with open(trace_path, "w") as f:
        json.dump(trace, f, indent=2, default=str)

    # Copy contract to output
    import shutil
    workspace_contract = os.path.join(base_dir, "workspace", game_id, "contract.json")
    if os.path.exists(workspace_contract):
        shutil.copy2(workspace_contract, os.path.join(output_dir, "contract.json"))

    elapsed = trace["total_duration_s"]
    status = "TIMEOUT" if trace.get("timeout") else "COMPLETE"
    print(f"\n=== PIPELINE {status} ===")
    print(f"Total: {elapsed:.1f}s / {PIPELINE_BUDGET}s budget")
    print(f"Output: {output_dir}/")
    print(f"Run:    bash {output_dir}/start.sh")

    return trace


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python orchestrator.py \"game prompt\" [--game-id ID]", file=sys.stderr)
        sys.exit(1)

    prompt = sys.argv[1]
    gid = None
    if "--game-id" in sys.argv:
        idx = sys.argv.index("--game-id")
        gid = sys.argv[idx + 1]

    trace = run_pipeline(prompt, gid)
    print(json.dumps(trace, indent=2, default=str))
