# pi agent config

My personal [pi coding agent](https://github.com/badlogic/pi-mono) setup: skills, custom agents, extensions, model profiles, and prompts.

## Extensions

### Local (`agent/extensions/`)

| Extension | Purpose |
|---|---|
| **pi-commandcode-provider** | Custom model provider for the Command Code API (commandcode.ai) — adds its models to pi, with OAuth auth, quota reporting, and CI for model-catalog updates. |
| **pi-subagent-profiles** | Model profiles for subagents: switch whole model configs with a shortcut, manage named profiles, and cycle the main session's model mode. |
| **instructions-loader** | Loads instruction files (`*.md`) from the global `agent/instructions/` dir and project-local `.pi/instructions/`, with an overlay UI to toggle them per session. |
| **skill-gate** | Interactive skill visibility manager — enable/disable skills globally or per project via overlay UI, with usage analytics. |
| **slash-autocomplete** | Replaces pi's inline slash-command autocomplete with a floating overlay popup aligned to the `/` column. |
| **input-history** | Custom input-line editor with persistent prompt history: up/down recall, fuzzy filtering over past inputs. |
| **git-committer** | `/git-committer` popup for staging files, AI-generated commit messages, committing, and pushing (shortcut: `ctrl+shift+g`). |

### Installed via npm (untracked, restored with `pi extmgr install`)

| Package | Purpose |
|---|---|
| **pi-extmgr** | Enhanced UX for managing local pi extensions and community packages. |
| **pi-atelier** | Responsive status rail and live activity sidebar. |
| **pi-zentui** | Starship-inspired statusline and Opencode-style TUI. |
| **pi-tool-display** | Compact tool-call rendering, diff visualization, and output truncation for a cleaner TUI. |
| **pi-files** | Widget showing agent-edited files above the input bar, plus an interactive gitignore-aware project tree. |
| **pi-fff** (`@ff-labs/pi-fff`) | FFF-powered fuzzy file and content search. |
| **pi-multi-skills** | Invoke installed skills anywhere in prompts with `$skill-name` syntax. |
| **pi-subagents** | Single-agent delegation and scripted multi-agent workflows. |
| **pi-mcp-adapter** | MCP (Model Context Protocol) adapter — connect external tool servers. |
| **pi-web-access** | Web search, URL fetching, GitHub repo cloning, PDF extraction, and video understanding. |
| **pi-ollama-cloud** | Ollama Cloud provider — models plus `ollama_web_search` / `ollama_web_fetch` tools. |
| **pi-antigravity** | Personal Antigravity / Cloud Code Assist provider (Google account auth, image generation). |
| **pi-claude-auth** | Use Claude Code credentials with pi — no separate login. |
| **pi-ask-herdr** | Adds an `ask_user` tool and Herdr notification integration. |
| **pi-autoresearch** | Autonomous experiment loop — run, measure, keep or discard. |
| **rpiv-todo** (`@juicesharp/rpiv-todo`) | Todo list for the model, rendered as a live overlay that survives `/reload` and compaction. |
| **pi-context-view** | Visualize context usage and inspect hidden parts: base prompt, tool defs, extension injections. |
| **ponytail** (`@dietrichgebert/ponytail`) | Lazy senior dev mode for AI agents. |
| **pi-extension** (`@plannotator/pi-extension`) | Plannotator — interactive plan review with annotations and code/PR review. |

Third-party provider: [`jellydn/pi-clinepass-provider`](https://github.com/jellydn/pi-clinepass-provider) is installed locally (git clone, not npm) but not tracked here.

## What else is here

- [`agent/skills/`](agent/skills/) — 36 custom skills (code review, TDD, design, research, web quality, …)
- [`agent/agents/`](agent/agents/) — subagent definitions (commit, design, explorer, oracle, research, reviewer, vision, sidekick)
- [`agent/profiles/`](agent/profiles/) — named model profiles (fast, deep, cheap, experiment, …)
- [`agent/prompts/`](agent/prompts/) — prompt templates (deep-research, fusion workflow)
- `settings.json`, `keybindings.json` — pi configuration

## Not in this repo (gitignored)

API keys (`agent/auth.json`), session transcripts, caches, memory databases, vendored `node_modules/`, and runtime state. Anything you don't see here is machine-local.
