# Invocation Contract

The command forms and behavior in this reference were tested with Grok Build
CLI 1.0.13 and `grok-4.6` on macOS.

## Canonical command

`GROK_HOME` is resolved once, before the first invocation: a store the user
names explicitly wins, then a `GROK_HOME` already set in the environment,
then the `$HOME/.grok` default. The `${GROK_HOME:-$HOME/.grok}` form below
encodes the environment-then-default part of that order; a user-named store
replaces it outright. Every invocation, retry, and resume carries the same
resolved value.

```sh
GROK_HOME="${GROK_HOME:-$HOME/.grok}" GROK_DISABLE_AUTOUPDATER=1 grok \
  --prompt-file prompt.md \
  --cwd <working-directory> \
  --sandbox <read-only|workspace> \
  --permission-mode bypassPermissions \
  --deny 'Bash(git push*)' \
  -m grok-4.6 \
  --effort <high|xhigh> \
  --max-turns <N> \
  --no-subagents \
  --output-format json \
  --json-schema "$(cat schema.json)" \
  > out.json 2> stderr.log
```

Use one isolated working directory and one complete artifact set per lane.

## Flag-by-flag contract

| Input | Why it is present |
| --- | --- |
| `GROK_HOME=...` | Selects the account, configuration, limits, and session store explicitly, using the resolved value: user choice, then the environment value, then `$HOME/.grok`. Authentication lives in the store: a session resumed under another store fails with `Not signed in`. |
| `GROK_DISABLE_AUTOUPDATER=1` | Suppresses the update check for the process. |
| `grok --prompt-file <path>` | Runs Grok headless with a file-backed prompt. `-p '<prompt>'` is the inline form. Headless mode never reads stdin. |
| `--cwd <working-directory>` | Sets the agent's working directory, the project-root discovery scope, and the session group. Give every writing lane its own Git worktree. |
| `--sandbox read-only` | Constrains evidence-only validators to reads plus writes under `$GROK_HOME` and temp directories. Child-process network blocking applies on Linux only. |
| `--sandbox workspace` | Enables writes to the working directory. Commits inside a Git worktree succeed under this profile. |
| `--permission-mode bypassPermissions` | Approves tool calls without a prompt. `deny` rules and hooks still apply. Headless mode cannot answer a permission prompt. |
| `--deny '<rule>'` | Blocks matching tool calls in every mode. Rules use `Bash(...)`, `Read(...)`, `Edit(...)`, `Write(...)`, `Grep(...)`, `WebFetch(...)`, and `MCPTool(...)`. Repeatable. |
| `--allow '<rule>'` | Approves matching calls under stricter modes. Allow rules are conjunctive across chained shell segments. |
| `-m grok-4.6` | Selects the model. Usage rows report the served model as `grok-4.6-build`. |
| `--effort high` | Fits review, judgment, mass triage, and ambiguous deep-dives. |
| `--effort xhigh` | Fits implementation, correction, adversarial validation, and independent technical review. |
| `--max-turns <N>` | Caps main-agent model rounds. Exceeding it ends the run with `stopReason` `cancelled`, exit 1, and `Error: max turns reached` on stderr. |
| `--no-subagents` | Removes subagent spawning so turns and usage stay attributable to the lane. |
| `--disable-web-search` | Removes `web_search` and `web_fetch`. Both are on by default. |
| `--tools <ids>` / `--disallowed-tools <ids>` | Allowlist or denylist built-in tools by internal id, such as `run_terminal_command`, `read_file`, `search_replace`, `write`, `grep`, `list_dir`, `web_search`, `web_fetch`, and `Agent`. |
| `--output-format json` | Writes one JSON object to stdout after the run. |
| `--output-format streaming-json` | Writes NDJSON events to stdout. The `end` event is last and carries the same fields as the JSON object. |
| `--json-schema '<schema>'` | Constrains the final response to a JSON Schema passed as inline text. The parsed result appears under `structuredOutput`. |
| `--rules '<text>'` | Appends rules to the system prompt. Keep the contract in `prompt.md` so a resume carries it. |
| `> out.json 2> stderr.log` | Keeps the result parseable. Warnings, update notices, and errors go to stderr. |
| `GROK_LOG_FILE=<path>` | Writes internal logs to a file; combine with `RUST_LOG=debug` for diagnosis. |
| `XAI_API_KEY` | Authenticates in environments without a browser login. |

## Prompt input rules

Headless mode reads the prompt from `-p`, `--prompt-file`, or `--prompt-json`.

For a file-backed prompt, use:

```sh
grok --prompt-file prompt.md [options]
```

A bare positional prompt starts the interactive TUI. Under a non-TTY it exits 1
with:

```text
Error: Device not configured (os error 6)
```

The same failure follows `grok - < prompt.md`.

Prompts above roughly 20 KB are offloaded to
`$GROK_HOME/sessions/<encoded-cwd>/<session-id>/prompts/prompt_0.txt`. The
model reads that file with `read_file` before working. A 60 KB prompt used two
turns and a 210 KB prompt used three turns for a one-line answer. Budget
`--max-turns` for the reads and keep `read_file` available to the lane.

Use prompt files for embedded plans, evidence, and review items. They avoid
shell-quoting failure and make the exact contract resumable.

## Output schemas

Pass the schema as inline text:

```sh
--json-schema "$(cat schema.json)"
```

A file path in that position fails before the model runs:

```text
Error: --json-schema: invalid JSON: expected value at line 1 column 1
```

Grok accepts schemas with and without `required` and
`additionalProperties: false`. Use the strict form anyway so the same schema
works across models and so extra keys are rejected:

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

The result object carries the parsed value under `structuredOutput` and the
serialized value under `text`:

```json
{
  "text": "{\"repo\":\"smoke\",\"ok\":true,\"items\":[...]}",
  "stopReason": "end_turn",
  "sessionId": "01a06373-f72a-7311-9bbd-adf112a27076",
  "structuredOutput": { "repo": "smoke", "ok": true, "items": [] }
}
```

Require one entry per requested item and validate coverage after parsing.
Schema validity alone cannot distinguish a complete result from an empty or
environmentally blocked result.

## Resume the same conversation

Capture `sessionId` from `out.json`. Associate it with its lane and
`GROK_HOME`, then persist it immediately.

Resume with a prompt file:

```sh
GROK_HOME="${GROK_HOME:-$HOME/.grok}" GROK_DISABLE_AUTOUPDATER=1 grok \
  --resume <session-id> \
  --prompt-file fix-prompt.md \
  --cwd <working-directory> \
  --permission-mode bypassPermissions \
  -m grok-4.6 \
  --effort xhigh \
  --max-turns <N> \
  --no-subagents \
  --output-format json \
  --json-schema "$(cat fix-schema.json)" \
  > fix-out.json 2> fix-stderr.log
```

Resume rules:

- `--resume <uuid>` finds the session from any shell directory and reports the
  original directory on stderr.
- The sandbox profile is fixed at creation. Omit `--sandbox` on resume; a
  different profile exits 1 with `cannot resume this session under sandbox
  profile '<x>' — it was created with '<y>'`.
- A session resumes only under the `GROK_HOME` that created it. Another store
  exits 1 with `Not signed in`.
- `-c` / `--continue` resumes the newest session of the current directory.
  Use it only outside fan-out.
- `-s` / `--session-id <uuid>` creates a new session with a client-chosen ID.
  `-s read-only` exits 1 with `--session-id must be a valid UUID`.
- `--fork-session` branches a resumed session into a new ID.

## Web search

`web_search` and `web_fetch` are available by default. Remove them for
closed-evidence lanes:

```sh
--disable-web-search
```

Restrict fetch targets with rules such as `--deny 'WebFetch(domain:example.com)'`.

## Pre-flight and cleanup

Smoke every `GROK_HOME` and every sandbox profile before fan-out. Exercise:

1. a trivial response with `--output-format json`;
2. each sandbox profile the run uses;
3. a real shell command:

   ```sh
   hostname
   ```

4. a read-only invocation with the production schema;
5. an isolated worktree write and commit for implementation lanes;
6. a same-home resume of the trivial session.

Inspect the configuration a lane inherits before launch:

```sh
grok inspect --json --cwd <working-directory>
```

The report lists the merged permission sources, hooks, plugins, and project
instructions the lane loads, including Claude Code settings and plugins under
`~/.claude`.

Every smoke creates a persistent session. Delete them:

```sh
grok sessions list --limit 20
grok sessions delete <session-id>
```

## Parse the output

### JSON object

`--output-format json` emits one object:

| Field | Action |
| --- | --- |
| `sessionId` | Persist immediately with the lane and `GROK_HOME`. |
| `stopReason` | Accept `end_turn`. Treat `cancelled` as incomplete and resumable. |
| `structuredOutput` | Validate against the schema and the expected item IDs. |
| `text` | Read the prose answer when no schema is set. |
| `usage`, `num_turns` | Record tokens and rounds per lane. |
| `total_cost_usd` | Record when present; absence means unreported, never free. |
| `usage_is_incomplete` | Treat token totals as a lower bound. |

### Streaming events

`--output-format streaming-json` emits one object per line. At minimum, handle:

| Event | Action |
| --- | --- |
| `available_commands` | Skip; it lists tools and slash commands. |
| `thought` | Skip or log. |
| `text` | Concatenate `data` to rebuild the answer. |
| `tool_call`, `tool_call_update` | Log for diagnosis; `rawOutput` carries command results. |
| `usage` | Record per-response token usage. |
| `max_turns_reached` | Mark the attempt incomplete. |
| `error` | Inspect `message` for authentication, limit, and environmental failures. |
| `end` | Read `sessionId`, `stopReason`, `structuredOutput`, and totals. Always last. |

### Errors and exit codes

Failures emit an error object on stdout and stderr and exit non-zero:

```json
{"type":"error","message":"Not signed in. To authenticate without a browser, run:\n  grok login --device-code ..."}
```

| Code | Meaning |
| --- | --- |
| `0` | The prompt completed. |
| `1` | Error: authentication, sandbox refusal, invalid flag, max turns, or runtime failure. |
| `124` | `timeout` killed the process without `--preserve-status`. |
| `130` | SIGINT. |
| `143` | SIGTERM, including `timeout --preserve-status`. |

Wrap lanes with `timeout --preserve-status` so the exit-code file records the
signal. The session is saved up to the last completed tool call and file
changes stay on disk; resume the session to continue.
