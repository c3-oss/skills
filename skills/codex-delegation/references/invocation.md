# Invocation Contract

The command forms and behavior in this reference were tested with Codex CLI
0.145.0 and `gpt-5.6-sol`.

## Canonical command

`CODEX_HOME` is resolved once, before the first invocation: a store the user
names explicitly wins, then a `CODEX_HOME` already set in the environment,
then the `$HOME/.codex` default. The `${CODEX_HOME:-$HOME/.codex}` form below
encodes the environment-then-default part of that order; a user-named store
replaces it outright. Every invocation, retry, and resume carries the same
resolved value.

```sh
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}" codex exec \
  -C <working-directory> \
  -s <read-only|danger-full-access> \
  -m gpt-5.6-sol \
  -c model_reasoning_effort="<high|xhigh>" \
  -c service_tier="fast" \
  --json \
  -o <final-output-file> \
  --output-schema <schema.json> \
  - < prompt.md > events.jsonl 2>&1
```

Use one isolated working directory and one complete artifact set per lane.

## Flag-by-flag contract

| Input | Why it is present |
| --- | --- |
| `CODEX_HOME=...` | Selects the account, configuration, limits, and session store explicitly, using the resolved value: user choice, then the environment value, then `$HOME/.codex`. Confirm the resolved store with a smoke before fan-out, and use the same value for every retry and resume. |
| `codex exec` | Runs Codex as an external, non-interactive process. Each invocation is an independent process. |
| `-C <working-directory>` | Sets the agent's working directory. Give every writing lane its own Git worktree. |
| `-s read-only` | Constrains evidence-only validators that need no writes. Verify it with a real shell-command smoke because nested `bwrap` can fail. |
| `-s danger-full-access` | Enables `.git` writes for implementation and correction. It also supports reviewers that need shell, `gh`, npm, Node, or independent research; confine read-only behavior through the prompt contract. |
| `-m gpt-5.6-sol` | Selects the GPT model used in the field guides. |
| `-c model_reasoning_effort="high"` | Fits review, judgment, mass triage, and ambiguous deep-dives. |
| `-c model_reasoning_effort="xhigh"` | Fits implementation, correction, adversarial validation, and independent technical review. |
| `-c service_tier="fast"` | Enables the fast tier through configuration. Use it for mechanical breadth and time-sensitive review. Omit this config for the default tier when deeper lane analysis warrants roughly 3–6× more time. |
| `-c tools.web_search=true` | Enables native web search when the lane must verify primary sources. |
| `--json` | Writes JSONL events to stdout. Capture the stream even when `-o` is present. |
| `-o <final-output-file>` | Writes the final agent response to a known path. Repository hooks can replace its contents, so retain and parse `events.jsonl`. |
| `--output-schema <schema.json>` | Constrains the final response to a strict JSON Schema and removes fragile prose parsing. |
| `-` | Tells `exec` to read the prompt from stdin. |
| `< prompt.md` | Supplies long, file-backed prompts safely and closes stdin at EOF. |
| `> events.jsonl 2>&1` | Persists the event stream and diagnostics for parsing, diagnosis, usage-limit detection, and resume recovery. |
| `--ephemeral` | Keeps smoke-test sessions out of the persistent session store. Use it before fan-out. |
| `--skip-git-repo-check` | Allows work in a lane directory where the Codex Git-repository check is not applicable, as in the direct mass-triage launcher. |

## Stdin rules

Always close stdin.

For a file-backed prompt, use:

```sh
codex exec [options] - < prompt.md
```

For a prompt passed as an argument, close inherited stdin:

```sh
codex exec [options] '<prompt>' </dev/null
```

A prompt argument with inherited open stdin can leave the process waiting at:

```text
Reading additional input from stdin...
```

Use prompt files for embedded plans, evidence, and review items. They avoid
shell-quoting failure and make the exact contract resumable.

## Strict output schemas

Codex output schemas follow the OpenAI strict-schema rules:

- List every key under `properties` in that object's `required` array.
- Set `additionalProperties: false` on every object at every nesting level.
- Validate the schema through a real, inexpensive invocation before fan-out.

This shape is valid:

```json
{
  "type": "object",
  "properties": {
    "repo": { "type": "string" },
    "ok": { "type": "boolean" },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "verdict": {
            "type": "string",
            "enum": ["pass", "fail", "contested"]
          }
        },
        "required": ["id", "verdict"],
        "additionalProperties": false
      }
    }
  },
  "required": ["repo", "ok", "items"],
  "additionalProperties": false
}
```

Require one entry per requested item and validate coverage after parsing.
Schema validity alone cannot distinguish a complete result from an empty or
environmentally blocked result.

## Resume the same conversation

Capture the `thread_id` from the first `thread.started` event. Associate it
with its lane and `CODEX_HOME`, then persist it immediately.

Resume with a prompt file:

```sh
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}" codex exec resume <thread_id> \
  -m gpt-5.6-sol \
  -c model_reasoning_effort="xhigh" \
  -c sandbox_mode="danger-full-access" \
  --json \
  -o <fix-output.json> \
  --output-schema <fix-schema.json> \
  - < fix-prompt.md > fix-events.jsonl 2>&1
```

In Codex CLI 0.145.0, `exec resume` accepts:

- `-c`;
- `-o`;
- `--output-schema`;
- `-m`.

It does not accept `-s`. Set the resumed sandbox through configuration:

```sh
-c sandbox_mode="danger-full-access"
```

A thread resumes only from the `CODEX_HOME` that created it. Use this property
to confirm the active account and store.

## Web search

Enable web search through configuration:

```sh
-c tools.web_search=true
```

`codex exec` 0.145.0 has no `--search` flag. Supplying it returns:

```text
error: unexpected argument
```

The process exits with status 1 before the model runs. Include the search
configuration in the pre-flight command shape.

## Ephemeral pre-flight

Smoke every `CODEX_HOME` before fan-out. Exercise:

1. a trivial response;
2. a read-only invocation with the production schema;
3. a real shell command:

   ```sh
   head -1 /etc/hostname
   ```

4. an isolated worktree write and commit for implementation lanes.

Use `--ephemeral` for these calls. Validate both the output and the real command
result. A PONG-only smoke can pass while every shell command in `read-only`
fails.

## Parse the JSONL stream

Read `events.jsonl` line by line as JSON. At minimum, handle:

| Event | Action |
| --- | --- |
| `thread.started` | Extract `thread_id` and persist it immediately with the lane and `CODEX_HOME`. |
| `agent_message` | Test the message against the lane schema and expected item IDs. Retain the last complete schema-valid candidate. |
| `turn.completed` | Record the reported token `usage`. |
| `error` | Inspect the message for usage limits and environmental failures. |
| `turn.failed` | Mark the attempt failed and correlate it with the preceding error. |

Repository hooks can make their own response the last message and overwrite the
`-o` file. Recover the result by iterating over `agent_message` events and
selecting the last message that validates against the schema and covers the
expected IDs, such as `R1-01`.

With `--output-schema`, intermediate messages can also resemble the final
schema:

```json
{"items":[],"notes":"still checking"}
```

Accept only the last complete candidate with required coverage.

When limits are exhausted, the stream contains an error shaped like:

```json
{"type":"error","message":"You've hit your usage limit..."}
```

It is followed by `turn.failed`, and the process exits with status 1. Pause the
affected side and activate the declared fallback plan; do not classify the
lane's subject matter from this attempt.
