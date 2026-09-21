# pi agent config

My personal [pi coding agent](https://github.com/badlogic/pi-mono) setup: skills, custom agents, extensions, model profiles, and prompts.

## Extensions

Custom extensions live in [`agent/extensions/`](agent/extensions/):

| Extension | Purpose |
|---|---|
| **pi-commandcode-provider** | Custom model provider for the Command Code API (commandcode.ai) — adds its models to pi, with OAuth auth, quota reporting, and CI for model-catalog updates. |
| **pi-subagent-profiles** | Model profiles for subagents: switch whole model configs with a shortcut, manage named profiles, and cycle the main session's model mode. |
| **instructions-loader** | Loads instruction files (`*.md`) from the global `agent/instructions/` dir and project-local `.pi/instructions/`, with an overlay UI to toggle them per session. |
| **skill-gate** | Interactive skill visibility manager — enable/disable skills globally or per project via overlay UI, with usage analytics. |
| **slash-autocomplete** | Replaces pi's inline slash-command autocomplete with a floating overlay popup aligned to the `/` column. |
| **input-history** | Custom input-line editor with persistent prompt history: up/down recall, fuzzy filtering over past inputs. |
| **git-committer** | `/git-committer` popup for staging files, AI-generated commit messages, committing, and pushing (shortcut: `ctrl+shift+g`). |

Also configured in `agent/extensions/` (config-only, for npm-installed extensions):

- **pi-files/** — settings for the pi-files extension
- **pi-tool-display/** — settings for the pi-tool-display extension

Third-party: [`jellydn/pi-clinepass-provider`](https://github.com/jellydn/pi-clinepass-provider) is installed locally but not tracked here (it has its own repo).

## What else is here

- [`agent/skills/`](agent/skills/) — 36 custom skills (code review, TDD, design, research, web quality, …)
- [`agent/agents/`](agent/agents/) — subagent definitions (commit, design, explorer, oracle, research, reviewer, vision, sidekick)
- [`agent/profiles/`](agent/profiles/) — named model profiles (fast, deep, cheap, experiment, …)
- [`agent/prompts/`](agent/prompts/) — prompt templates (deep-research, fusion workflow)
- `settings.json`, `keybindings.json` — pi configuration

## Not in this repo (gitignored)

API keys (`agent/auth.json`), session transcripts, caches, memory databases, vendored `node_modules/`, and runtime state. Anything you don't see here is machine-local.
