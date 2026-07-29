# Gotchas

These fifteen failure modes preserve the order in which they appeared across
the two field guides.

## 1. `workspace-write` blocks `.git`

**What happens:** Branch and commit operations fail with:

```text
Operation not permitted
```

The `workspace-write` sandbox cannot write the worktree's `.git` state. A check
with `--strict-config` found only `network_access`, `writable_roots`, and
`exclude_*` controls under `sandbox_workspace_write`; none overrides this
restriction.

**Why it hurts:** An implementation lane can edit files and then fail at the
required branch or commit operation.

**Mitigation:** Give lanes that commit `-s danger-full-access`. Isolate each
lane in its own worktree and make the prompt contract explicit: work only in
that worktree, never touch `main`, and never force-push.

## 2. Open stdin hangs `codex exec`

**What happens:** A prompt passed as an argument while stdin remains open can
wait indefinitely at:

```text
Reading additional input from stdin...
```

**Why it hurts:** The lane appears active, consumes a concurrency slot, and
never reaches a result.

**Mitigation:** Close stdin with `</dev/null` when passing a prompt argument.
For long prompts, use:

```sh
- < prompt.md
```

This reads the prompt from a file and closes stdin at EOF.

## 3. Output schemas are strict

**What happens:** The endpoint rejects the entire schema when a property is not
listed in `required`. One observed failure was:

```text
Invalid schema ... Missing 'area'
```

Every object level also requires `additionalProperties: false`. A single
invalid shared schema caused 16 lanes to fail identically.

**Why it hurts:** The invocation fails before the model performs useful work,
and a fan-out multiplies the same configuration error across every lane.

**Mitigation:** Put every property in `required`, set
`additionalProperties: false` at every object level, and validate the exact
schema with a real inexpensive call before fan-out.

## 4. Repository hooks can overwrite the `-o` file

**What happens:** Codex repository hooks, such as stop or lesson-reflection
hooks, can emit the last message. That hook response becomes the final response
and overwrites the file selected by `-o`, while the actual lane result remains
inside `events.jsonl`.

**Why it hurts:** A parser that trusts only `out.json` can discard a correct
result or ingest the hook's unrelated output.

**Mitigation:** Preserve `events.jsonl`. Iterate over `agent_message` events
and select the last message that validates against the lane's schema and covers
its expected IDs, such as `R1-01`.

## 5. Intermediate messages can be schema-shaped

**What happens:** With `--output-schema`, intermediate model messages can take
the schema's shape:

```json
{"items":[],"notes":"still checking"}
```

**Why it hurts:** A weak parser or workflow executor can accept progress as the
final result, especially when empty arrays remain schema-valid.

**Mitigation:** Require one entry per requested item, instruct the model to
avoid narrating progress, and accept only the last schema-valid message with
complete coverage. Combine this validation with the JSONL recovery required by
gotcha 4.

## 6. Usage-limit monitoring can select the wrong account

**What happens:** `codexbar` prefers web-dashboard cookies and ignores
`CODEX_HOME`, so it can display a different account. The definitive account
check is session ownership: a `thread_id` resumes only from the home that
created it.

When the active account reaches its limit, the stream contains:

```json
{"type":"error","message":"You've hit your usage limit..."}
```

The stream then emits `turn.failed`, and the process exits with status 1.

**Why it hurts:** The orchestrator can misread available capacity, treat an
account pause as a lane verdict, or retry repeatedly against the exhausted
store.

**Mitigation:** Set `CODEX_HOME` explicitly, confirm it with a same-home
resume, parse limit events, and pause the affected model side. Keep unaffected
Claude lanes running. Declare a fallback before launch; one field run assigned
the final three rebases to Sonnet agents under the same prompt contract.

## 7. `exec resume` has a different sandbox interface

**What happens:** In Codex CLI 0.145.0, `exec resume` accepts `-c`, `-o`,
`--output-schema`, and `-m`, but rejects `-s`.

**Why it hurts:** Reusing the initial invocation flags can terminate a fix lane
before it resumes the conversation.

**Mitigation:** Configure the resume sandbox with:

```sh
-c sandbox_mode="danger-full-access"
```

Keep the original `CODEX_HOME` and persist the resumed event stream.

## 8. Negative instructions are applied literally

**What happens:** A contract that said never to write in `.workflow/` caused an
implementer to omit two mandatory evidence files in that directory and report
the conflict.

**Why it hurts:** A broad prohibition can block a requirement that the same
prompt expects the agent to fulfill.

**Mitigation:** Audit negative instructions against the concrete steps. Grant
narrow exceptions through the same thread, for example:

```text
EXCEPTION GRANTED: you may write exactly these 2 files: ...
```

Keep the exception explicit and enumerated.

## 9. Nested `read-only` sandboxing can break shell commands

**What happens:** On one nested host, `codex exec -s read-only` connected,
answered a PONG prompt, and exited with status 0, while every model shell
command failed with:

```text
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

The model returned schema-valid JSON with a `contested` verdict explaining that
it could not read the evidence.

**Why it hurts:** A schema-only validator can convert an honest environmental
failure into a false subject-matter verdict. A no-tool smoke does not expose
the failure.

**Mitigation:** Require a real shell operation in every sandbox smoke:

```sh
head -1 /etc/hostname
```

Validate its returned content before launching lanes.

## 10. Broken read-only sandboxes require an evidence strategy

**What happens:** A validator cannot investigate when its shell is unavailable.
Two working strategies cover the task:

1. Keep `-s read-only` and embed the complete evidence set in `prompt.md`. A
   field run used about 520 KB, approximately 135k tokens, successfully.
2. Use `-s danger-full-access` with a strict read-only prompt contract that
   permits only inspection, such as `gh view` or `gh api GET`.

**Why it hurts:** Applying one strategy to every validator either blocks
self-investigation or grants broad access without a precise behavioral
contract.

**Mitigation:** Use inline evidence when the evidence is closed and known. Use
`danger-full-access` with prompt confinement when the model must investigate
independently.

## 11. `--search` is not an `exec` flag

**What happens:** Codex CLI 0.145.0 rejects `--search` before the model runs:

```text
error: unexpected argument
```

The process exits with status 1.

**Why it hurts:** A shared invalid flag kills every fan-out lane identically.

**Mitigation:** Enable native web search through configuration:

```sh
-c tools.web_search=true
```

Run the exact production command shape with `--ephemeral` before scaling.

## 12. Environmental failures are `VOID`

**What happens:** An honest model can return schema-valid output saying it
could not read evidence, execute commands, or verify the task. The verdict
field may say `contested`.

**Why it hurts:** Including that result in synthesis turns lack of evidence
into an opinion about the underlying implementation or decision.

**Mitigation:** Add an explicit environmental-failure check after schema and
coverage validation. Mark the lane `VOID` and rerun it with inline evidence, a
working sandbox, or another declared execution strategy.

## 13. Multiple `CODEX_HOME` stores are independent

**What happens:** Stores such as `~/.codex` and `~/.codex-work` can hold different
accounts and usage limits. A thread resumes only in the store that created it.

**Why it hurts:** A retry under another home loses the conversation, can use
the wrong account, and reports capacity from the wrong limit pool.

**Mitigation:** Smoke every home separately. Record the home beside every
`thread_id`, and set that exact `CODEX_HOME` in every initial call, retry, and
resume.

## 14. Secret-bearing evidence needs structural verification

**What happens:** A validator asked to prove a credential leak can reproduce
the credential in its own report. The field case involved a Mongo credential.

**Why it hurts:** The validation artifact becomes a second disclosure.

**Mitigation:** Require structural evidence and explicit redaction:

```text
Verify that no credential appears. Describe the URI; do not quote it.
```

Report features such as presence or absence of `@`, userinfo length, and query
string shape without reproducing the value.

## 15. Fast and default tiers are a quality lever

**What happens:** `high` plus the fast tier processed about 28 PRs per mass
triage lane in minutes. For ambiguous decisions, `high` on the default tier
produced visibly deeper options and concrete risks at roughly 3–6× the time.

**Why it hurts:** Selecting a tier by habit can spend deep-analysis latency on
mechanical breadth or reduce the quality of ambiguous decisions.

**Mitigation:** Use:

```sh
-c service_tier="fast"
```

for mechanical classification and state checks. Omit `service_tier` to use the
default tier for deep-dive analysis.
