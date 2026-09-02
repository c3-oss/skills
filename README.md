# C3 Skills

Agent skills for Claude Code.

## Install

Install with `npx skills`:

```bash
npx skills add c3-oss/skills                       # install all skills
npx skills add c3-oss/skills --skill codex-delegation
npx skills add c3-oss/skills --skill grok-delegation
```

Or add the Claude Code plugin marketplace:

```text
/plugin marketplace add c3-oss/skills
/plugin install c3-oss-skills@c3-oss
```

## Skills

| Skill | Description |
| --- | --- |
| `codex-delegation` | Delegate implementation, review, validation, and mass triage to GPT models through the Codex CLI. |
| `grok-delegation` | Delegate implementation, review, validation, and mass triage to Grok models through the Grok Build CLI. |

## License

CC0-1.0. Dedicated to the public domain.
