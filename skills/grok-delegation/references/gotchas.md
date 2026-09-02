# Gotchas

Items 1 through 14 were observed with Grok Build CLI 1.0.13 on macOS or are
documented in its user guide. Items 15 through 19 are model-agnostic lessons
that carry over from Codex delegation runs.

## 1. A positional prompt starts the TUI

**What happens:** `grok "<prompt>"` opens the interactive session. Under a
non-TTY the process exits 1 with:

```text
Error: Device not configured (os error 6)
```

`grok - < prompt.md` fails the same way, because headless mode reads no stdin.

**Why it hurts:** Every lane in a fan-out dies before the model runs.

**Mitigation:** Use `-p '<prompt>'` or `--prompt-file prompt.md`.

## 2. `-s` is the session ID, and the sandbox is `--sandbox`

**What happens:** `-s read-only` exits 1 with:

```text
Error: --session-id must be a valid UUID (got 'read-only').
```

**Why it hurts:** A flag carried over from another CLI kills every identical
lane.

**Mitigation:** Pass `--sandbox <profile>`. Reserve `-s` for a client-chosen
UUID on a new session.

## 3. `--json-schema` takes inline text

**What happens:** A file path in that position exits 1 with:

```text
Error: --json-schema: invalid JSON: expected value at line 1 column 1
```

**Why it hurts:** The invocation fails before the model performs useful work,
and a fan-out multiplies the error across every lane.

**Mitigation:** Pass `--json-schema "$(cat schema.json)"` and read the parsed
value from `structuredOutput`.

## 4. A sandbox profile that cannot be applied refuses to start

**What happens:** On a macOS host where `/var/run/docker.sock` is a symlink,
`--sandbox read-only` and `--sandbox strict` exit 1 with:

```text
warning: sandbox could not be applied: runtime-socket deny resolution failed: could not resolve runtime-socket deny path /var/run/docker.sock: endpoint is a symlink
error: could not apply the 'read-only' sandbox profile; see the warning above for the cause. Refusing to start with its protections missing.
```

`--sandbox workspace` starts on the same host.

**Why it hurts:** Every validator lane on that profile fails identically, and
the failure depends on the host, not on the prompt.

**Mitigation:** Smoke every profile the run uses on the host that runs it.
Fall back to `workspace` with `--disallowed-tools run_terminal_command` and
`--deny 'Edit'`, `--deny 'Write'` for validators, or to a custom profile in
`$GROK_HOME/sandbox.toml`.

## 5. Large prompts are offloaded and cost turns

**What happens:** A prompt file above roughly 20 KB is written to
`$GROK_HOME/sessions/<encoded-cwd>/<session-id>/prompts/prompt_0.txt`, and the
model reads it with `read_file` before answering. A 210 KB prompt under
`--max-turns 2` ended with `stopReason` `cancelled` and
`Error: max turns reached`; the same prompt under `--max-turns 6` succeeded in
three turns.

**Why it hurts:** A tight turn budget or a `--tools` allowlist without
`read_file` converts a valid prompt into an incomplete lane.

**Mitigation:** Budget extra turns for inline evidence, keep `read_file`
available, and validate `stopReason` before parsing the result.

## 6. `--max-turns` ends the run as `cancelled` with exit 1

**What happens:** Exceeding the cap emits `stopReason` `cancelled`, a
`max_turns_reached` event in streaming output, `Error: max turns reached` on
stderr, and exit status 1. `text` holds whatever the model said last.

**Why it hurts:** A parser that reads `text` without `stopReason` accepts a
progress message as the result. A parser that treats exit 1 as an error hides
a resumable lane.

**Mitigation:** Accept only `end_turn`. Resume a `cancelled` session with a
larger `--max-turns` instead of marking it `VOID`.

## 7. Resume pins the sandbox profile

**What happens:** Passing a different `--sandbox` on `--resume` exits 1 with:

```text
error: cannot resume this session under sandbox profile 'workspace' — it was created with 'off'. Omit --sandbox to resume with 'off', or start a new session to use 'workspace'.
```

**Why it hurts:** Reusing the initial invocation flags with a changed profile
terminates a fix lane before it resumes the conversation.

**Mitigation:** Choose the profile at creation and omit `--sandbox` on every
resume.

## 8. A session resumes only under its `GROK_HOME`

**What happens:** `--resume` under another store exits 1 with:

```json
{"type":"error","message":"Not signed in. To authenticate without a browser, run:\n  grok login --device-code ..."}
```

Authentication, configuration, sessions, and usage limits all live in the
store.

**Why it hurts:** A retry under another home loses the conversation, can use
the wrong account, and reports capacity from the wrong limit pool.

**Mitigation:** Record the home beside every `sessionId`, and set that exact
`GROK_HOME` in every initial call, retry, and resume.

## 9. Sessions always persist

**What happens:** Every headless run, including a smoke, creates a session
under `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/`. `grok sessions list`
shows the sessions of the current directory only.

**Why it hurts:** Smoke sessions accumulate, and `-c` / `--continue` picks the
newest session of the directory, which in a fan-out is not the lane's session.

**Mitigation:** Delete smoke sessions with `grok sessions delete <id>`. Resume
lanes by UUID only.

## 10. stderr carries warnings and errors

**What happens:** The JSON result goes to stdout. Sandbox warnings, resume
notes such as `Session <id> found locally`, update checks, and error messages
go to stderr.

**Why it hurts:** `2>&1` into `out.json` breaks the JSON parse on the first
warning.

**Mitigation:** Redirect `> out.json 2> stderr.log`, set
`GROK_DISABLE_AUTOUPDATER=1`, and read `stderr.log` during diagnosis.

## 11. `timeout` reports 124 by default

**What happens:** `timeout 3 grok ...` exits 124 when it kills the process.
`timeout --preserve-status 3 grok ...` exits 143, the SIGTERM code Grok
documents.

**Why it hurts:** An exit-code classifier keyed on 143 misses every expired
lane.

**Mitigation:** Use `timeout --preserve-status` in the launcher, or treat both
124 and 143 as timeouts.

## 12. Lanes inherit Claude Code configuration

**What happens:** Grok reads `~/.claude/settings.json` permission rules,
`~/.claude/Claude.md`, Claude plugins and their hooks, and configured MCP
servers. The streaming `available_commands` event lists every inherited tool
and slash command, including MCP tools from browser and search servers.

**Why it hurts:** A lane can call tools the contract never mentioned, and a
`Stop` hook from a plugin can keep the turn running and change the final
text.

**Mitigation:** Run `grok inspect --json --cwd <lane>` before fan-out, remove
unwanted tools with `--disallowed-tools` or `--deny 'MCPTool(<server>__*)'`,
and validate the final result against the schema and item coverage.

## 13. Two tool vocabularies

**What happens:** `--tools` and `--disallowed-tools` take internal ids such as
`run_terminal_command`, `read_file`, `search_replace`, `write`, `grep`,
`list_dir`, `web_search`, `web_fetch`, and `Agent`. `--allow` and `--deny`
take `Bash(...)`, `Read(...)`, `Edit(...)`, `Write(...)`, `Grep(...)`,
`WebFetch(...)`, and `MCPTool(...)`. A rule naming an unrecognized tool is
skipped with a warning.

**Why it hurts:** A misspelled restriction silently leaves the tool available.

**Mitigation:** Use the internal id list from `available_commands` for tool
filters and the rule syntax for permission rules. Confirm the restriction
with a smoke that tries the forbidden action.

## 14. Child-network blocking is Linux-only

**What happens:** The `read-only` and `strict` profiles block child-process
network access through seccomp on Linux. On macOS the block is a no-op, and
`curl` inside the lane reaches the network.

**Why it hurts:** A validator that must work from inline evidence only can
still fetch external content on macOS.

**Mitigation:** Combine `--disable-web-search` with `--disallowed-tools
run_terminal_command` for closed-evidence validators, or run those lanes on
Linux.

## 15. Intermediate messages can be schema-shaped

**What happens:** With a schema, intermediate model messages can take the
schema's shape:

```json
{"items":[],"notes":"still checking"}
```

**Why it hurts:** A weak parser or workflow executor can accept progress as the
final result, especially when empty arrays remain schema-valid.

**Mitigation:** Require one entry per requested item, instruct the model to
avoid narrating progress, and accept only a `structuredOutput` with complete
coverage and `stopReason` `end_turn`.

## 16. Negative instructions are applied literally

**What happens:** A contract that says never to write in `.workflow/` can make
an implementer omit mandatory evidence files in that directory and report the
conflict.

**Why it hurts:** A broad prohibition can block a requirement that the same
prompt expects the agent to fulfill.

**Mitigation:** Audit negative instructions against the concrete steps. Grant
narrow exceptions through the same session, for example:

```text
EXCEPTION GRANTED: you may write exactly these 2 files: ...
```

Keep the exception explicit and enumerated.

## 17. Environmental failures are `VOID`

**What happens:** An honest model can return schema-valid output saying it
could not read evidence, execute commands, or verify the task. The verdict
field may say `contested`.

**Why it hurts:** Including that result in synthesis turns lack of evidence
into an opinion about the underlying implementation or decision.

**Mitigation:** Add an explicit environmental-failure check after schema and
coverage validation. Mark the lane `VOID` and rerun it with inline evidence, a
working sandbox, or another declared execution strategy.

## 18. Secret-bearing evidence needs structural verification

**What happens:** A validator asked to prove a credential leak can reproduce
the credential in its own report.

**Why it hurts:** The validation artifact becomes a second disclosure.

**Mitigation:** Require structural evidence and explicit redaction:

```text
Verify that no credential appears. Describe the URI; do not quote it.
```

Report features such as presence or absence of `@`, userinfo length, and query
string shape without reproducing the value.

## 19. Effort is the quality lever

**What happens:** `grok-4.6` accepts `low`, `medium`, `high`, and `xhigh`.
Higher effort spends more reasoning per turn and more wall-clock per lane.

**Why it hurts:** Selecting effort by habit spends deep-analysis latency on
mechanical breadth or reduces the quality of ambiguous decisions.

**Mitigation:** Use `high` for mechanical classification, state checks, and
review; use `xhigh` for implementation, correction, and adversarial
validation.
