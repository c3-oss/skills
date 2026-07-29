# Orchestration Patterns

## Direct process fan-out

Use direct processes when the orchestration needs a concurrency cap, durable
lane artifacts, and a completion signal without a workflow layer.
Each `codex exec` is independent; one field run reached eight simultaneous
implementation lanes.

```sh
run_lane() {
  d="$1"
  timeout 2700 env CODEX_HOME="$HOME/.codex" codex exec --skip-git-repo-check \
    -C "$d" -s danger-full-access -m gpt-5.6-sol \
    -c model_reasoning_effort="high" -c service_tier="fast" \
    --json -o "$d/out.json" --output-schema "$RUN/schema.json" \
    - < "$d/prompt.md" > "$d/events.jsonl" 2>&1
  echo "$?" > "$d/exit-code"
}
export RUN
export -f run_lane

find "$RUN/lanes" -mindepth 1 -maxdepth 1 -type d -name 'lane-*' -print0 |
  xargs -0 -P 7 -I{} bash -c 'run_lane "$@"' _ {}
echo done > "$RUN/launch-complete"
```

This launcher gives every lane:

- a 2,700-second timeout;
- an explicit `CODEX_HOME`;
- a dedicated prompt, output, event stream, and exit-code file;
- a set-level `launch-complete` marker after `xargs` has waited for all lanes.

Keep the launcher itself waiting on its children. Never place `&` inside a
shell that the outer orchestrator already runs in the background: the wrapper
can exit and signal completion while detached Codex processes still run.
Use blocking `xargs`, an explicit `wait`, or monitor a marker:

```sh
until [ -f "$RUN/launch-complete" ]; do
  sleep 20
done
```

Build bins by repository, not by item count alone. Repository-local state
queries can be reused inside a lane.

A field run used seven simultaneous processes for 385 PRs across 14 lanes of
about 28 PRs, making roughly 2,000 `gh` calls without reaching GitHub's
5,000-per-hour rate limit. Treat that result as observed headroom for that run,
not as a substitute for monitoring the current run.

The default-tier deep-dive covered 82 ambiguous PRs across 50 lanes.

## Dumb executor inside a Claude Workflow

Use a cheap Claude model as a mechanical executor when the Workflow supplies
fan-out, concurrency control, structured output validation, visible progress,
and journaled results, while GPT performs the analysis.

```text
Claude Workflow
  └─ agent(model: "haiku", schema: OUT) × N lanes
       └─ Bash: codex exec ...  # GPT-5.6-sol performs the analysis
```

Give the executor numbered mechanical steps:

1. Create the lane directory.

   ```sh
   mkdir -p <lane-directory>
   ```

2. Write `schema.json` with the exact content embedded in the executor prompt.
3. Write `prompt.md` with the exact delimited GPT prompt embedded in the
   executor prompt.
4. Start Codex through Bash with `run_in_background: true` and wait for the
   completion notification. `high` and `xhigh` lanes can exceed the Bash
   foreground timeout of 10 minutes.
5. Validate `out.json`:
   - it parses as JSON;
   - it contains one entry for every listed item;
   - it contains no fabricated result.
6. When `out.json` is invalid, parse `events.jsonl`, find the last
   schema-valid `agent_message` with full coverage, and replace `out.json`.
7. Return this structured envelope:

   ```json
   {
     "repo": "<repository>",
     "ok": true,
     "result_json": "<validated Codex JSON>",
     "problems": "<executor problems>"
   }
   ```

8. Retry at most once and never manufacture output.

Tell GPT to produce one entry per item and avoid progress narration. The
coverage check catches schema-valid empty arrays and intermediate
schema-shaped messages.

The observed executor failure rate was about 16%: 8 of 50 lanes. Failures
included Haiku returning its own narration as the Codex result and setting
`ok=true` with an empty `prs` array.

Retry a failed executor lane by skipping the intermediary and running Codex
directly against the existing `prompt.md` and `schema.json`. In the observed
run, the eight failed lanes were retried with `xargs -P 7`, and all eight
completed successfully. The on-disk artifacts made the retry a 15-line script.

## Run-directory persistence

Create the complete run directory before launching any process:

```text
<run>/
  prs.json
  schema.json
  launch.sh
  README.md
  state.json
  lanes/
    lane-NN/
      input.json
      prompt.md
      events.jsonl
      out.json
      exit-code
  results/
  launch-complete
  retry-*-complete
```

The run `README.md` records:

- the inventory and contract;
- the exact launch and retry commands;
- the `CODEX_HOME` used by the run;
- the schema and coverage rules;
- how to recover `thread_id` values from `events.jsonl`;
- how to call `codex exec resume` in the same home.

Keep per-item state in `state.json`:

```json
{
  "ITEM-001": {
    "stage": "review",
    "pr": 123,
    "worktree": "<worktree-path>",
    "threads": {
      "implement": "<thread-id>",
      "review": "<thread-id>"
    }
  }
}
```

Write state atomically: write a temporary file in the run directory, then
rename it over `state.json`. Treat plans, prompts, reviews, event streams,
outputs, exit codes, and marker files as the resumption truth. A lane retry
reuses its directory. An executor retry runs Codex directly over the same
files.

## Cross-model division of labor

Assign different model families to every critical implementation/review or
review/re-review pair. The value comes from decorrelated critiques:

- Codex caught a `NameError` that a plan would have introduced.
- Codex caught two real regressions in PRs approved by Opus.
- Codex found an SSRF path through DNS rebinding.
- Codex found a systemic pattern of silently ignored evaluation rubrics.
- A Sonnet re-review found a regression introduced by Codex's own fix.
- Sonnet `xhigh` adversarial validation refuted 7 of 19 supersession verdicts
  from broad GPT triage.
- GPT refuted an SRV recommendation that Fable had marked as preferable.

Use the second model as an independent critic with its own evidence contract.
The design goal is disagreement with technical evidence, not selection of a
universally superior model.

## Fix rounds through resume

Send correction work back to the implementation thread:

```sh
CODEX_HOME="<original-home>" codex exec resume <implementation-thread-id> \
  -m gpt-5.6-sol \
  -c model_reasoning_effort="xhigh" \
  -c sandbox_mode="danger-full-access" \
  --json \
  -o <lane>/fix-out.json \
  --output-schema <run>/fix-schema.json \
  - < <lane>/fix-prompt.md > <lane>/fix-events.jsonl 2>&1
```

Build `fix-prompt.md` around stable review IDs:

```text
Resolve each open item:

- R1-01: <specific finding and evidence>
- R1-02: <specific finding and evidence>

For each ID, return fixed or contested.
For fixed, cite the commit that mentions the ID.
For contested, give the concrete technical justification.
Your final response must contain only JSON matching the supplied schema.
```

Require an entry for every open ID. Permit `contested` with technical
justification. Reject generic statements such as "fixed everything." Preserve
the fix event stream and update state with every resumed thread or turn.

Unblock the lane in this order:

1. diagnose the exact failure from `events.jsonl`;
2. coach the same thread through `resume` with the missing context;
3. intervene directly only for mechanical obstacles such as a dependency,
   worktree, credential, or PR creation during an API outage;
4. escalate business decisions to the human.

## Declared Plan B for usage limits

Define the fallback before fan-out. Record:

- the JSONL signatures for exhaustion:

  ```json
  {"type":"error","message":"You've hit your usage limit..."}
  ```

  followed by `turn.failed` and process exit status 1;
- which lanes pause;
- which other-model lane type takes over;
- the unchanged prompt, schema, evidence, and validation contract;
- the state and marker updates that distinguish fallback work.

A usage-limit attempt has no subject-matter verdict. Keep unaffected lanes
running and reassign the paused work under the same file-backed contract. In
one run, Sonnet agents took over the final three rebases.
