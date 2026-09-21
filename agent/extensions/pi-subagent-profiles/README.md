# pi-subagent-profiles

`pi-subagent-profiles` is a pi extension that gives subagent spawns a named,
ordered model fallback chain and an optional thinking level. It handles Agent
tool calls from pi-subagents, pi's built-in Agent tool, and the `subagent` tool
from @arhen/pi-core-subagent (single, `tasks`, and `chain` forms). The profile
is read
from disk on each state lookup, so nested sessions that load the global
extensions see the same activation state.

## Features

- Named YAML profiles under `<agentDir>/subagent-profiles/profiles/`.
- Fuzzy model matching with provider/model, exact model id, id substring, and
  display-name substring matching.
- Fallback chains are checked against authenticated models before injection.
- Per-agent overrides match `subagent_type` case-insensitively.
- Profile values replace caller `model` and `thinking` values when a valid
  profile value exists.
- Optional per-rule worktree isolation for subagent spawns (git projects only).
- Agent frontmatter pins are removed line-by-line when a profile is activated,
  at session start, or during resource discovery.
- A machine-owned `imported` profile records the first stripped pin for each
  agent without activating that profile.
- Global and project activation layers, with project state taking precedence.
- `/profiles` command, TUI menu, and profile creation wizard.
- Per-profile `mainModel` modes (`cheap`, `default`, `slow`) with `Ctrl+Shift+M` cycling.
- Per-profile `inject: false` to disable spawn-time injection (see below).

## pi-subagents JSON profiles

The extension also reads the profile store of
[pi-subagents](https://github.com/nicobailon/pi-subagents):

```text
<agentDir>/profiles/pi-subagents/*.json
```

A JSON profile carries the routing pi-subagents applies from settings
(`subagents.defaultModel`, `subagents.defaultThinking`,
`subagents.agentOverrides`) plus extension-owned top-level fields that
pi-subagents tolerates and ignores:

```json
{
  "subagents": {
    "defaultModel": "opencode-go/deepseek-v4-flash",
    "defaultThinking": "max",
    "agentOverrides": {
      "reviewer": { "model": "anthropic/claude-opus-5", "thinking": "high" }
    }
  },
  "mainModel": {
    "cheap": "opencode-go/qwen3.8-flash:high",
    "default": "ollama-cloud/glm-5.3",
    "slow": "ollama-cloud/kimi-k3"
  },
  "mainThinking": "max"
}
```

- `mainModel` accepts a single model string or the three tiers (`cheap`,
  `default`, `slow`), with the same per-model thinking suffixes as YAML.
- `/profiles use <name>` switches everything, for both stores, and writes routing into the **scope's** settings file — the project's `.pi/settings.json` by default, user `settings.json` with `--global` (mirroring pi-subagents' `/subagents-load-profile`: the profile owns the complete agent mapping, unrelated settings such as `disableBuiltins` survive, `machine` pins are preserved). It then applies `mainModel`/`mainThinking`. Running sessions need `/reload` for pi-subagents to see new routing. With `--global`, a warning fires when project routing pins would mask the user settings.
  - JSON profile: writes its `subagents` block as-is.
  - YAML profile: derives the routing block from its rules (first resolvable non-inherit chain entry per rule, unresolvable models skipped) and writes that.
  - Both then apply `mainModel`/`mainThinking`.
- `/profiles off` restores the previous main model/thinking and removes the routing keys (`defaultModel`, `defaultThinking`, `agentOverrides`) from the scope's settings file — user settings for `--global`, project `.pi/settings.json` for `--project`. Unrelated settings survive.
- `/profiles list` marks the state-active profile with `*` and, by reading
  pi-subagents settings (user merged with project), the profile whose routing
  the settings currently match with `=`.
- JSON profiles never spawn-inject and never strip frontmatter (inject is
  always off for them); routing is pi-subagents' settings, the extension only
  owns mainModel/mainThinking.
- A JSON profile wins over a same-named YAML profile. `/profiles create`
  writes a JSON profile into the pi-subagents store (single model per role,
  optional `mainModel` single or `cheap`/`default`/`slow` tiers); `/profiles
  delete` and `/profiles validate` work on both stores.
- `/profiles strip` refuses while the active profile does not own spawn
  routing (`inject: false`): pi-subagents respects agent frontmatter pins, so
  stripping them would delete meaningful configuration.

## Spawn injection and the `inject` flag

A profile may set a top-level `inject: false` to disable all spawn-time routing:
model and thinking injection, per-rule worktree isolation, and the agent
frontmatter strip pass. The profile then only controls `mainModel`/`mainThinking`
and the `Ctrl+Shift+M` mode cycling. This is for setups where subagent model
routing is owned by [pi-subagents](https://github.com/nicobailon/pi-subagents)
profiles (`subagents.agentOverrides` in settings), which a `tool_call` injection
here would otherwise override. Profiles without the key keep the historic
inject-enabled behavior.

```yaml
name: Development
inject: false
mainModel:
  cheap: opencode-go/qwen3.8-flash:high
  default: ollama-cloud/glm-5.3
  slow: ollama-cloud/kimi-k3
mainThinking: max
```

The extension never re-applies main-session settings inside pi-subagents child
processes (`PI_SUBAGENT_CHILD=1`), so background children keep their resolved
model.

## Profile YAML format

A profile has a default rule, optional per-agent rules, and an optional main
model. `models` is ordered from preferred to least preferred. Unknown top-level
keys are tolerated when parsing.

```yaml
name: fast-review
description: Fast models for review work
default:
  models:
    - anthropic/claude-sonnet-4
    - openai/gpt-4o
  thinking: medium
  isolation: true
overrides:
  Explore:
    models:
      - anthropic/claude-haiku-4
    thinking: low
mainModel: anthropic/claude-sonnet-4
mainThinking: high
```

Or define up to three main-session tiers on one profile. Each tier may carry
the same per-model thinking suffix used on subagent model entries. A suffix
overrides `mainThinking` for that mode only.

```yaml
mainModel:
  cheap: ollama-cloud/glm-5.2
  default: ollama-cloud/kimi-k3
  slow: anthropic/claude-opus-5:high
mainThinking: xhigh
```

Press `Ctrl+Shift+M` to cycle the active profile's main model mode in order
cheap → default → slow → cheap. The selected mode is stored in project or
global state and shown in the status line as `profile: <name> · main:<mode>`.
Profiles with a single `mainModel` string ignore cycling. A YAML key of `fast`
is accepted as an alias for `cheap`.

`thinking` and `mainThinking` may be `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, or `max`. A rule must contain at least one
model string.

A model entry may carry a per-model thinking suffix that overrides the rule's
`thinking` for that model only. The suffix is the last `:`-separated segment
when it is a valid thinking level; otherwise the whole string is the model id.
Model ids that already contain `:` (for example `deepseek-v4-flash:0731`) keep
the colon as part of the id, so a per-model override on such a model is written
as `deepseek-v4-flash:0731:max`. The `inherit` sentinel ignores any suffix; use
the rule-level `thinking` for `inherit` entries.

```yaml
overrides:
  vision:
    models:
      - anthropic/claude-opus-4-7:medium
      - ollama-cloud/minimax-m3
    thinking: max
```

Here `claude-opus-4-7` runs at `medium` when it resolves, and `minimax-m3`
falls back to the rule-level `max`.
`mainModel` uses the same fuzzy matching rules and is subject to model scope.
A `mainModel` string, including each mode in a mapping, may carry a thinking
suffix. That suffix wins over `mainThinking` for the selected model. If neither
the suffix nor `mainThinking` is set, the main-session thinking level is left
unchanged. `mainThinking` still applies when no main model is configured. It
is clamped to the active model's capabilities. On deactivation, the previous
main-session level is restored only when it has not been changed manually in
the meantime.

`isolation` is an optional per-rule boolean, default false. When true, spawns
matched by that rule run in a temporary git worktree (pi's
`isolation: "worktree"`). Injection requires the project to be a git
repository; otherwise it is skipped with a one-time warning. Unlike model and
thinking, `isolation: true` only ever adds worktree isolation, and false or
omitted never touches a caller-provided `isolation` value.

## Activation and injection

Global state is stored at:

```text
<agentDir>/subagent-profiles/state.json
```

The project override is stored at:

```text
<cwd>/.pi/subagent-profiles.json
```

The project file wins. An `active` string selects a project profile; an
explicit `active: null` disables the global profile for that project. Removing
the project key returns resolution to the global state. The project override
file is intentionally a normal, committable project file for team sharing.

When a profile is active, the `tool_call` handler selects the matching agent
override or the default rule. It resolves each model string in order against
pi's authenticated model catalogue and injects the first one that resolves as
`provider/modelId`. If no model resolves, no new model value is injected and
the spawn inherits its parent model. A configured profile thinking level is
injected as well.

If `mainModel` resolves, activation attempts to switch pi's main model. The
previous main model is backed up for deactivation. A failed switch is
reported but does not prevent profile activation. Thinking is then applied
from the selected model's suffix, or from `mainThinking` if the suffix is
absent, after the model switch so capability clamping is final. Its previous
level is backed up for deactivation and restored only when the profile scope
is deactivated and the level has not been changed manually.

When a pi session starts with a profile already active (the project override
wins over global), the extension re-applies the profile's `mainModel` and
`mainThinking`. The same availability and model-scope checks and failure
warnings apply as at activation, previous values are still backed up for
deactivation restore, and a failed switch warns without blocking startup.

## Imported frontmatter pins

Agent files are discovered in these flat directories:

```text
<cwd>/.pi/agents/*.md
<cwd>/.agents/agents/*.md
<agentDir>/agents/*.md
```

At activation and lifecycle refresh, top-level zero-indentation `model:` and
`thinking:` lines in YAML frontmatter are removed without YAML round-tripping
the agent file. Line endings, comments, nested mappings, and the rest of the
file are retained byte-for-byte. A blank scalar followed by an indented line
is treated as a multiline value and is skipped rather than modified.

Captured values are merged into:

```text
<agentDir>/subagent-profiles/profiles/imported.yaml
```

The imported profile has a default `inherit` sentinel and one override per
captured agent. Existing override keys win forever; later captures do not
replace them. In a model chain, `inherit` means that the profile has no model
opinion and the caller's model is left untouched; it is a valid chain outcome,
not a model to resolve. The profile is never auto-activated.

## Command reference

```text
/profiles                        profile manager console (TUI popup)
/profiles use <name> [--global|--project]
/profiles off [--global|--project]
/profiles show                   details of the active profile only
```

Bare `/profiles` opens a multi-pane console over the pi-subagents JSON store:
left pane lists profiles (`*` = state-active), right pane lists actions for the
highlighted profile — Activate (project), Activate (global), Edit, Delete — plus
New profile, Deactivate (off), and Close. `up/down` moves, `tab` switches pane,
`enter` runs, `n` opens the new-profile wizard, `esc` closes. Deleting the
active profile is refused; a profile's name is immutable after creation
(rename = delete + create).

The create/edit wizard walks name, description, default model/thinking,
per-agent overrides, and mainModel (single or `cheap`/`default`/`slow` tiers)
with the same fuzzy model picker as the CLI. Saving validates and reports
model-resolution issues, but always writes; activating a profile with
validation errors is blocked. Saved profiles land in:

```text
<agentDir>/profiles/pi-subagents/<name>.json
```

`use` and `off` keep the typed-command semantics: routing goes to the scope's
settings file (project `.pi/settings.json` by default, user settings with
`--global`), and `off` strips the routing keys from that scope.

`Ctrl+Shift+M` cycles the active profile's main-model tier (cheap → default →
slow) when it has tiers. All notifications are prefixed with `profiles: `.
Headless sessions cannot open the console; `use`, `off`, and `show` work there
(notifications are quiet).

## Known gaps

- Scheduled agents and RPC spawns bypass pi's `tool_call` event, so `inject`
  profiles never inject for them.
- The YAML store is legacy: profiles there are still loadable with
  `/profiles use <name>` but do not appear in the console and cannot be edited
  there.
- Thinking is injected even when no chain model validates; the profile owns
  thinking independently (legacy `inject` profiles only).
- State and profile files use atomic writes, but there is no cross-process
  locking, so the last writer wins.
- The project override file `<cwd>/.pi/subagent-profiles.json` is committable;
  this is intentional for team sharing.
