---
name: codex-delegation
description: This skill applies when delegating implementation, code review, adversarial validation, or mass triage to a GPT model through the Codex CLI (`codex exec`). It also applies when orchestrating a fan-out of external agent processes, seeking a decorrelated second-model opinion, or fixing and iterating on a prior Codex thread.
---

# Codex Delegation

Treat Codex as a remote engineer that communicates through processes and files.

## Mental model

- Treat every `codex exec` invocation as an independent external process.
- Implement fan-out with background processes and an explicit concurrency cap.
- Sessions persist under `~/.codex/sessions/`.
- Persist all run artifacts before launch. Read the first JSONL event,
  `thread.started`, and persist its `thread_id` immediately.
- Continue the same conversation with:

```sh
codex exec resume <thread_id> - < follow-up.md
```

- Use `resume` for review fixes, coaching, and further investigation. The
  resumed process retains the conversation context.
- Observe the event stream and final output; internal reasoning is not visible.
- Control each lane with three layers:
  1. a prompt contract;
  2. schema and coverage validation;
  3. programmatic gates backed by external evidence.
- Treat the model's report as input to a decision, not as the decision.

See [Invocation details](references/invocation.md) for session and event semantics.

## Invocation contract

Resolve `CODEX_HOME` once, before the first invocation, in this order:

1. a store the user names explicitly ("use CODEX_HOME X");
2. a `CODEX_HOME` already set in the environment;
3. the `$HOME/.codex` default.

Pass the resolved value explicitly in every invocation, retry, and resume.

Use this command shape:

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

| Input | Purpose |
| --- | --- |
| `CODEX_HOME` | Select the account, config, sessions, and usage limits explicitly, using the resolved value (user choice, then environment, then `$HOME/.codex`). |
| `-C` | Set the lane's working directory. |
| `-s` | Select `read-only` for observation or `danger-full-access` for commits and self-investigation. |
| `-m` | Select `gpt-5.6-sol`. |
| `model_reasoning_effort` | Use `high` for broad mechanical work and review; use `xhigh` for implementation, correction, and adversarial work. |
| `service_tier` | Use `"fast"` for mechanical breadth; omit it for deeper default-tier analysis. |
| `--json` | Emit the JSONL event stream. |
| `-o` | Write the final response to a file. |
| `--output-schema` | Enforce the final response's JSON Schema. |
| `- < prompt.md` | Close stdin after reading a file-backed prompt. |

Keep long prompts in files. Validate schemas with a real invocation: list every
property in `required` and set `additionalProperties: false` on every object.
Read [Invocation details](references/invocation.md) before using or resuming a lane.

## Pre-flight smoke

Run pre-flight checks before every fan-out and for every `CODEX_HOME`.

1. Run a trivial `--ephemeral` invocation.
2. Run a read-only `--ephemeral` invocation with the production schema.
3. Require a real shell command such as:

   ```sh
   head -1 /etc/hostname
   ```

4. Validate the command result, not only a schema-valid response.
5. Run an isolated `--ephemeral` worktree write and commit for implementation.
6. Confirm the exact production command shape, including every `-c` key.
7. Confirm a captured thread resumes under the creating `CODEX_HOME`.

A PONG-only smoke cannot reveal a broken nested `read-only` sandbox. Wrong flags
or schemas terminate every identical lane. See [Gotchas](references/gotchas.md).

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
- Capture `events.jsonl`, `out.json`, and `exit-code` per lane.
- Parse and persist `thread_id` as soon as `thread.started` appears.
- Bound each lane with a timeout and the set with a concurrency limit.
- Write a completion marker after every launcher process has exited.

### Validate

- Validate the final JSON against the schema.
- Check that one result exists for every requested item.
- Recover the last schema-valid `agent_message` from `events.jsonl` when hooks
  overwrite `out.json`.
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

- Resume the implementation thread for every correction round.
- Send the open findings with stable item IDs.
- Require commits to mention the corresponding item IDs.
- Accept `contested` only with specific technical justification.
- Reject generic claims such as "fixed everything."
- Unblock in this order:
  1. diagnose from `events.jsonl`;
  2. coach the same thread with missing context through `resume`;
  3. intervene directly only for mechanical obstacles such as dependencies,
     worktrees, credentials, or creating a PR during an API outage;
  4. escalate only business decisions to the human.

See [Orchestration patterns](references/patterns.md) for fan-out, retries, and
traceable fix rounds.

## Sandbox, effort, and tier selection

| Role | Effort and tier | Sandbox and evidence | Rationale |
| --- | --- | --- | --- |
| Adversarial evidence validator | `xhigh` + `fast` | `read-only`; evidence inline | Produces a decorrelated critique without tool access. |
| Second technical reviewer with web research | `xhigh` + `fast` | `danger-full-access`; `tools.web_search=true` | Uses shell and primary-source web research for independent verification. |
| Mass triage | `high` + `fast` | `danger-full-access`; read-only prompt contract | Optimizes mechanical breadth while allowing read-only `gh` investigation. |
| Ambiguous-decision deep-dive | `high`; default tier | `danger-full-access`; read-only prompt contract | Trades roughly 3–6× more time for deeper per-lane analysis. |

Use inline evidence when the evidence set is closed and known. A tested prompt
of about 520 KB, approximately 135k tokens, worked with `read-only` because the
model needed no tools.

Use `danger-full-access` with strict prompt confinement for shell, `gh`, Node,
npm, or web investigation. Constrain read-only roles to `gh view`, `gh api GET`,
and other explicit read operations.

Treat every environmental-failure result as a `VOID` lane. Re-run it with
inline evidence, a working sandbox, or another declared strategy.

See [Gotchas](references/gotchas.md) for sandbox, search, account, secret, and tier details.

## State and persistence

Create the complete run directory before the first process starts. Include:

- the inventory and inputs;
- `schema.json`;
- a launch script;
- one directory per lane;
- `prompt.md`, `events.jsonl`, `out.json`, and `exit-code` per lane;
- completion and retry marker files;
- a results directory;
- a run `README.md` containing the contract, inventory, re-execution commands,
  `CODEX_HOME`, and resume instructions.

Keep a `state.json` entry per item with stage, PR, worktree, and all role-specific
thread IDs such as `implement` and `review`. Write state atomically through a
temporary file and rename.

Treat on-disk artifacts as the resumption truth. Recover `thread_id` from
`events.jsonl` and resume it under the same `CODEX_HOME`.

See [Orchestration patterns](references/patterns.md) for the complete layout.

## Checklist

```text
[ ] CODEX_HOME is resolved once (user choice > environment > ~/.codex)
[ ] The resolved CODEX_HOME is explicit in every invocation and retry
[ ] Account is confirmed through auth.json and a successful same-home resume
[ ] Every CODEX_HOME passed an --ephemeral smoke with a real shell command
[ ] Trivial, read-only schema, and isolated commit smokes passed
[ ] Exact production command shape passed before fan-out
[ ] Web search uses -c tools.web_search=true
[ ] Prompt enters through - < prompt.md with closed stdin
[ ] Every schema property is required; every object rejects additional properties
[ ] Schema passed a real invocation
[ ] Closed evidence is inline; self-investigation has explicit tool confinement
[ ] Secret-bearing evidence requires structural description without quotation
[ ] Writing lanes use isolated worktrees and danger-full-access
[ ] Run directory and resume README exist before launch
[ ] Every thread_id is persisted immediately and associated with its CODEX_HOME
[ ] Every lane has timeout, exit-code, events, output, and coverage validation
[ ] The launcher uses no detached &; it waits and writes a completion marker
[ ] Results are recovered from JSONL when hooks overwrite the -o file
[ ] Environmental failures become VOID lanes and are rerun
[ ] External evidence confirms every reported success
[ ] CI evaluation and merge occur in separate steps
[ ] Corrections resume the implementer's thread with traceable item IDs
[ ] Critical implementation/review pairs use different model families
[ ] Fast tier serves mechanical breadth; default tier serves deep analysis
[ ] Usage-limit events pause affected lanes and activate the declared plan B
[ ] Workflow executors expose ok, enforce coverage, and never fabricate output
[ ] Failed intermediary lanes retry Codex directly on the same disk artifacts
```

## References

- [Invocation details](references/invocation.md) — commands, flags, schemas, stdin, resume, search, ephemeral runs, repository checks, and JSONL parsing.
- [Gotchas](references/gotchas.md) — all fifteen observed failure modes and mitigations.
- [Orchestration patterns](references/patterns.md) — direct fan-out, workflow executors, persistence, cross-model review, fix rounds, and usage-limit Plan B.
