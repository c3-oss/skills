---
name: grok-delegation
description: This skill applies when delegating implementation, code review, adversarial validation, or mass triage to a Grok model through the Grok Build CLI (`grok -p`). It also applies when orchestrating a fan-out of external agent processes, seeking a decorrelated second-model opinion, or fixing and iterating on a prior Grok session.
---

# Grok Delegation

Treat Grok as a remote engineer that communicates through processes and files.

## Mental model

- Treat every headless `grok` invocation as an independent external process.
- Implement fan-out with background processes and an explicit concurrency cap.
- Sessions persist under `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/`.
- Persist all run artifacts before launch. Read `sessionId` from the JSON
  result and persist it immediately.
- Continue the same conversation with:

```sh
grok --resume <session-id> --prompt-file follow-up.md
```

- Use `--resume` for review fixes, coaching, and further investigation. The
  resumed process retains the conversation context and the sandbox profile.
- Observe the result object, the event stream, and the on-disk session log;
  internal reasoning arrives only as `thought` summaries.
- Control each lane with three layers:
  1. a prompt contract;
  2. schema and coverage validation;
  3. programmatic gates backed by external evidence.
- Enforce lane boundaries with two mechanisms: the OS sandbox (`--sandbox`)
  limits what the process can touch; the permission layer
  (`--permission-mode`, `--deny`) limits what the model may request.
- Treat the model's report as input to a decision, not as the decision.

See [Invocation details](references/invocation.md) for session and output semantics.

## Invocation contract

Resolve `GROK_HOME` once, before the first invocation, in this order:

1. a store the user names explicitly ("use GROK_HOME X");
2. a `GROK_HOME` already set in the environment;
3. the `$HOME/.grok` default.

Pass the resolved value explicitly in every invocation, retry, and resume.

Use this command shape:

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

| Input | Purpose |
| --- | --- |
| `GROK_HOME` | Select the account, config, sessions, and usage limits explicitly, using the resolved value (user choice, then environment, then `$HOME/.grok`). |
| `GROK_DISABLE_AUTOUPDATER=1` | Keep update checks out of the lane. |
| `--prompt-file` | Read a file-backed prompt. Headless mode reads no stdin. |
| `--cwd` | Set the lane's working directory and its session group. |
| `--sandbox` | Select `read-only` for observation or `workspace` for commits and self-investigation. Smoke every profile: a profile that cannot be applied refuses to start. |
| `--permission-mode bypassPermissions` | Approve tool calls without prompts; headless mode cannot answer a prompt. |
| `--deny` | Encode hard limits as rules; deny wins over every mode. Repeatable. |
| `-m` | Select `grok-4.6`. |
| `--effort` | Use `high` for broad mechanical work and review; use `xhigh` for implementation, correction, and adversarial work. |
| `--max-turns` | Bound the lane. A prompt above roughly 20 KB costs extra read turns. |
| `--no-subagents` | Keep the lane single-process so `num_turns` and `usage` stay attributable. |
| `--output-format json` | Emit one JSON object with `text`, `structuredOutput`, `stopReason`, `sessionId`, and `usage`. |
| `--json-schema` | Enforce the final response's JSON Schema; the value is the inline schema text. |
| `> out.json 2> stderr.log` | Keep stdout for the result and stderr for warnings and errors. |

Keep long prompts in files. Validate schemas with a real invocation.
Read [Invocation details](references/invocation.md) before using or resuming a lane.

## Pre-flight smoke

Run pre-flight checks before every fan-out and for every `GROK_HOME`.

1. Run a trivial `-p` invocation with `--output-format json` and read
   `sessionId`, `stopReason`, and `text`.
2. Run each sandbox profile the run uses with a trivial prompt. A profile that
   cannot be applied exits 1 before the model runs.
3. Require a real shell command such as:

   ```sh
   hostname
   ```

4. Validate the command result, not only a schema-valid response.
5. Run a read-only invocation with the production schema and validate
   `structuredOutput`.
6. Run an isolated worktree write and commit under the writing profile.
7. Confirm the exact production command shape, including every flag.
8. Confirm a captured `sessionId` resumes under the creating `GROK_HOME`.
9. Delete smoke sessions with `grok sessions delete <session-id>`.

A PONG-only smoke cannot reveal a broken sandbox or a blocked shell. Wrong
flags or schemas terminate every identical lane. See [Gotchas](references/gotchas.md).

## Roles and the per-item cycle

You orchestrate. Do not implement or review the delegated content yourself.
Prepare environments, launch lanes, persist state, validate outputs, apply
gates, and unblock agents.

### Prepare

- Create one isolated worktree or directory for each writing lane.
- Start the prompt with a one-line role.
- Add a non-negotiable contract in bullets:
  - exact workdir and scope;
  - Git rules and permitted branch;
  - forbidden mutations;
  - repository-specific test commands;
  - commit format;
  - final-output format;
  - an instruction not to ask questions.
- Encode every prohibition that a rule can express as a `--deny` rule as well.
- Add concrete, numbered steps and exact repository commands.
- Include environment forms when required, such as
  `env -u VIRTUAL_ENV UV_PROJECT_ENVIRONMENT=$PWD/.venv`.
- Include required plans, evidence, and review items in the prompt.
- End with an escape valve: when scope is ambiguous or entangled, stop and
  report the exact overlap rather than guessing.
- Grant explicit, narrowly enumerated exceptions to negative rules when the
  work requires them.
- For secret-bearing evidence, require structural verification: describe the
  URI or value shape and never quote the secret.

### Launch

- Write `prompt.md`, `schema.json`, the launch command, and lane metadata first.
- Launch each process in the background through a wrapper that waits for it.
- Capture `out.json`, `stderr.log`, and `exit-code` per lane.
- Parse and persist `sessionId` as soon as `out.json` exists.
- Bound each lane with `--max-turns` and `timeout --preserve-status`, and the
  set with a concurrency limit.
- Write a completion marker after every launcher process has exited.

### Validate

- Validate `structuredOutput` against the schema.
- Check that one result exists for every requested item.
- Accept only `stopReason` equal to `end_turn`. Treat `cancelled` with
  `max turns reached` on stderr as an incomplete lane to resume.
- Reject progress messages that merely resemble the final schema.
- Mark a lane `VOID` when it reports inability to read evidence, run commands,
  authenticate, or complete environmental setup.
- Validate external facts independently: the PR exists, the expected commit
  names the item, required files exist, and CI is green.

### Gate

Apply every gate in a separate step:

1. read the result;
2. evaluate the condition;
3. perform the action only after the condition passes.

Keep inspection and mutation in separate shell or tool calls. A command
sequence that inspects CI and merges in one unconditioned call is not a gate.

### Fix and unblock

- Resume the implementation session for every correction round.
- Send the open findings with stable item IDs.
- Require commits to mention the corresponding item IDs.
- Accept `contested` only with specific technical justification.
- Reject generic claims such as "fixed everything."
- Unblock in this order:
  1. diagnose from `stderr.log` and the session's `updates.jsonl`;
  2. coach the same session with missing context through `--resume`;
  3. intervene directly only for mechanical obstacles such as dependencies,
     worktrees, credentials, or creating a PR during an API outage;
  4. escalate only business decisions to the human.

See [Orchestration patterns](references/patterns.md) for fan-out, retries, and
traceable fix rounds.

## Sandbox, permissions, and effort selection

| Role | Effort | Sandbox, permissions, and evidence | Rationale |
| --- | --- | --- | --- |
| Adversarial evidence validator | `xhigh` | `read-only`; `--disable-web-search`; `--disallowed-tools run_terminal_command`; evidence inline | Produces a decorrelated critique without tool access. |
| Second technical reviewer with web research | `xhigh` | `workspace`; `bypassPermissions`; `--deny 'Edit'`, `--deny 'Write'`; web search on by default | Uses shell and primary-source web research for independent verification. |
| Mass triage | `high` | `workspace`; `bypassPermissions`; read-only prompt contract | Optimizes mechanical breadth while allowing read-only `gh` investigation. |
| Ambiguous-decision deep-dive | `high` | `workspace`; `bypassPermissions`; larger `--max-turns` | Trades more turns for deeper per-lane analysis. |
| Implementation and correction | `xhigh` | `workspace`; `bypassPermissions`; isolated worktree; `--deny 'Bash(git push*)'` | Commits inside a worktree succeed under `workspace`. |

Use inline evidence when the evidence set is closed and known. Prompts above
roughly 20 KB are offloaded to a file that the model reads with `read_file`;
budget the extra turns and keep `read_file` available.

Use `workspace` with strict prompt confinement for shell, `gh`, Node, npm, or
web investigation. Constrain read-only roles to `gh view`, `gh api GET`, and
other explicit read operations, and add `--deny` rules for edits.

Treat every environmental-failure result as a `VOID` lane. Re-run it with
inline evidence, a working sandbox, or another declared strategy.

See [Gotchas](references/gotchas.md) for sandbox, permission, session, and prompt-size details.

## State and persistence

Create the complete run directory before the first process starts. Include:

- the inventory and inputs;
- `schema.json`;
- a launch script;
- one directory per lane;
- `prompt.md`, `out.json`, `stderr.log`, and `exit-code` per lane;
- completion and retry marker files;
- a results directory;
- a run `README.md` containing the contract, inventory, re-execution commands,
  `GROK_HOME`, and resume instructions.

Keep a `state.json` entry per item with stage, PR, worktree, and all role-specific
session IDs such as `implement` and `review`. Write state atomically through a
temporary file and rename.

Treat on-disk artifacts as the resumption truth. Recover `sessionId` from
`out.json` and resume it under the same `GROK_HOME`. Export a readable
transcript with `grok export <session-id> transcript.md`.

See [Orchestration patterns](references/patterns.md) for the complete layout.

## Checklist

```text
[ ] GROK_HOME is resolved once (user choice > environment > ~/.grok)
[ ] The resolved GROK_HOME is explicit in every invocation and retry
[ ] Account is confirmed through a trivial run and a successful same-home resume
[ ] Every sandbox profile in use passed a smoke with a real shell command
[ ] Trivial, read-only schema, and isolated worktree commit smokes passed
[ ] Exact production command shape passed before fan-out
[ ] Prompt enters through --prompt-file; prompts above ~20 KB have extra turns budgeted
[ ] Schema is passed inline through --json-schema and passed a real invocation
[ ] Closed evidence is inline; self-investigation has explicit tool confinement
[ ] Secret-bearing evidence requires structural description without quotation
[ ] Writing lanes use isolated worktrees, workspace sandbox, and bypassPermissions
[ ] Hard limits are --deny rules, not only prose
[ ] Every lane sets --max-turns and --no-subagents
[ ] stdout goes to out.json and stderr to stderr.log, never merged
[ ] Run directory and resume README exist before launch
[ ] Every sessionId is persisted immediately and associated with its GROK_HOME
[ ] Every lane has timeout --preserve-status, exit-code, output, and coverage validation
[ ] The launcher uses no detached &; it waits and writes a completion marker
[ ] Only stopReason end_turn is accepted; cancelled lanes are resumed
[ ] Resumes omit --sandbox and reuse the creating GROK_HOME
[ ] Environmental failures become VOID lanes and are rerun
[ ] External evidence confirms every reported success
[ ] CI evaluation and merge occur in separate steps
[ ] Corrections resume the implementer's session with traceable item IDs
[ ] Critical implementation/review pairs use different model families
[ ] Error results pause affected lanes and activate the declared plan B
[ ] Workflow executors expose ok, enforce coverage, and never fabricate output
[ ] Failed intermediary lanes retry Grok directly on the same disk artifacts
```

## References

- [Invocation details](references/invocation.md) — commands, flags, schemas, prompt input, resume, web search, pre-flight cleanup, and output parsing.
- [Gotchas](references/gotchas.md) — observed and documented failure modes with mitigations.
- [Orchestration patterns](references/patterns.md) — direct fan-out, workflow executors, persistence, cross-model review, fix rounds, and error Plan B.
