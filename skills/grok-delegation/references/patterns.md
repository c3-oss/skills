# Orchestration Patterns

## Direct process fan-out

Use direct processes when the orchestration needs a concurrency cap, durable
lane artifacts, and a completion signal without a workflow layer.
Each headless `grok` process is independent.

```sh
run_lane() {
  d="$1"
  timeout --preserve-status 2700 env \
    GROK_HOME="$HOME/.grok" GROK_DISABLE_AUTOUPDATER=1 grok \
    --prompt-file "$d/prompt.md" --cwd "$d" \
    --sandbox workspace --permission-mode bypassPermissions \
    --deny 'Bash(git push*)' \
    -m grok-4.6 --effort high --max-turns 40 --no-subagents \
    --output-format json --json-schema "$(cat "$RUN/schema.json")" \
    > "$d/out.json" 2> "$d/stderr.log"
  echo "$?" > "$d/exit-code"
}
export RUN
export -f run_lane

find "$RUN/lanes" -mindepth 1 -maxdepth 1 -type d -name 'lane-*' -print0 |
  xargs -0 -P 7 -I{} bash -c 'run_lane "$@"' _ {}
echo done > "$RUN/launch-complete"
```

This launcher gives every lane:

- a 2,700-second timeout that records exit 143 on expiry;
- an explicit `GROK_HOME`;
- a dedicated prompt, output, stderr, and exit-code file;
- a set-level `launch-complete` marker after `xargs` has waited for all lanes.

Keep the launcher itself waiting on its children. Never place `&` inside a
shell that the outer orchestrator already runs in the background: the wrapper
can exit and signal completion while detached Grok processes still run.
Use blocking `xargs`, an explicit `wait`, or monitor a marker:

```sh
until [ -f "$RUN/launch-complete" ]; do
  sleep 20
done
```

Build bins by repository, not by item count alone. Repository-local state
queries can be reused inside a lane. Monitor the rate limits of every external
API the lanes call, such as GitHub's per-hour budget for `gh`.

## Dumb executor inside a Claude Workflow

Use a cheap Claude model as a mechanical executor when the Workflow supplies
fan-out, concurrency control, structured output validation, visible progress,
and journaled results, while Grok performs the analysis.

```text
Claude Workflow
  └─ agent(model: "haiku", schema: OUT) × N lanes
       └─ Bash: grok --prompt-file ...  # grok-4.6 performs the analysis
```

Give the executor numbered mechanical steps:

1. Create the lane directory.

   ```sh
   mkdir -p <lane-directory>
   ```

2. Write `schema.json` with the exact content embedded in the executor prompt.
3. Write `prompt.md` with the exact delimited Grok prompt embedded in the
   executor prompt.
4. Start Grok through Bash with `run_in_background: true` and wait for the
   completion notification. `high` and `xhigh` lanes can exceed the Bash
   foreground timeout of 10 minutes.
5. Validate `out.json`:
   - it parses as JSON;
   - `stopReason` is `end_turn`;
   - `structuredOutput` contains one entry for every listed item;
   - it contains no fabricated result.
6. When `out.json` is invalid, read `stderr.log` and the session's
   `updates.jsonl`, and report the failure instead of a result.
7. Return this structured envelope:

   ```json
   {
     "repo": "<repository>",
     "ok": true,
     "result_json": "<validated Grok JSON>",
     "problems": "<executor problems>"
   }
   ```

8. Retry at most once and never manufacture output.

Tell Grok to produce one entry per item and avoid progress narration. The
coverage check catches schema-valid empty arrays and intermediate
schema-shaped messages.

Retry a failed executor lane by skipping the intermediary and running Grok
directly against the existing `prompt.md` and `schema.json`. The on-disk
artifacts make the retry a short script.

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
      out.json
      stderr.log
      exit-code
  results/
  launch-complete
  retry-*-complete
```

The run `README.md` records:

- the inventory and contract;
- the exact launch and retry commands;
- the `GROK_HOME` used by the run;
- the schema and coverage rules;
- how to recover `sessionId` values from `out.json`;
- how to call `grok --resume` in the same home.

Keep per-item state in `state.json`:

```json
{
  "ITEM-001": {
    "stage": "review",
    "pr": 123,
    "worktree": "<worktree-path>",
    "sessions": {
      "implement": "<session-id>",
      "review": "<session-id>"
    }
  }
}
```

Write state atomically: write a temporary file in the run directory, then
rename it over `state.json`. Treat plans, prompts, reviews, outputs, stderr
logs, exit codes, and marker files as the resumption truth. A lane retry
reuses its directory. An executor retry runs Grok directly over the same
files.

Grok keeps its own copy of every lane under
`$GROK_HOME/sessions/<encoded-cwd>/<session-id>/`: `updates.jsonl` holds the
tool calls and results, and `prompts/` holds offloaded prompts. Export a
readable transcript with `grok export <session-id> transcript.md`.

## Cross-model division of labor

Assign different model families to every critical implementation/review or
review/re-review pair. The value comes from decorrelated critiques: a second
family catches regressions, unsafe paths, and silently ignored requirements
that the first family approved, and the first family refutes verdicts the
second family reached with weak evidence.

Use the second model as an independent critic with its own evidence contract.
The design goal is disagreement with technical evidence, not selection of a
universally superior model.

## Fix rounds through resume

Send correction work back to the implementation session:

```sh
GROK_HOME="<original-home>" GROK_DISABLE_AUTOUPDATER=1 grok \
  --resume <implementation-session-id> \
  --prompt-file <lane>/fix-prompt.md \
  --cwd <lane-worktree> \
  --permission-mode bypassPermissions \
  --deny 'Bash(git push*)' \
  -m grok-4.6 --effort xhigh --max-turns 40 --no-subagents \
  --output-format json --json-schema "$(cat <run>/fix-schema.json)" \
  > <lane>/fix-out.json 2> <lane>/fix-stderr.log
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
the fix output and stderr, and update state with every resumed session.

Unblock the lane in this order:

1. diagnose the exact failure from `stderr.log` and `updates.jsonl`;
2. coach the same session through `--resume` with the missing context;
3. intervene directly only for mechanical obstacles such as a dependency,
   worktree, credential, or PR creation during an API outage;
4. escalate business decisions to the human.

## Declared Plan B for errors and limits

Define the fallback before fan-out. Record:

- the error signature: an object shaped like

  ```json
  {"type":"error","message":"..."}
  ```

  on stdout, the same message on stderr, and process exit status 1;
- the messages that mean the store is unusable, such as `Not signed in` and
  `could not apply the '<profile>' sandbox profile`;
- which lanes pause;
- which other-model lane type takes over;
- the unchanged prompt, schema, evidence, and validation contract;
- the state and marker updates that distinguish fallback work.

An error attempt has no subject-matter verdict. Keep unaffected lanes running
and reassign the paused work under the same file-backed contract.
