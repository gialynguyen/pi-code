# instructions-loader

Pi extension that manages markdown **instruction files** and injects the enabled
ones into the system prompt right after the first user message. Sessions that
never send a message never pay the tokens.

## Instruction files

Flat `*.md` files (no subdirectories, dotfiles ignored):

| Scope | Directory |
|-------|-----------|
| global | `~/.pi/agent/instructions/` |
| project | `<project>/.pi/instructions/` |

Filename sans `.md` = id shown everywhere. Optional frontmatter:

```markdown
---
description: Auth & security rules for this repo
---

Actual instruction content…
```

Body after the frontmatter is what gets loaded.

## Scopes

- **global / project** — persisted in `<dir>/state.json`, which stores only
  *disabled* names (`{"disabled": ["name"]}`). Default is enabled. The project
  state file is personal preference → the extension drops a `.gitignore` with
  `state.json` into the project instructions dir.
- **session** — in-memory 3-valued overlay (`force-on` / `force-off` /
  `unset`), dies with the conversation. Lets you temporarily re-enable a
  globally-disabled instruction (or vice versa).

**Shadowing:** a project file with the same name as a global one wins — the
global copy is never loaded and shown greyed with a `shadowed` badge in the UI.
Shadowing is by file existence only; disabling the project copy does not
un-shadow the global one.

**Trust:** project instructions load only in trusted projects
(`ctx.isProjectTrusted()`); instructions from an untrusted project would be a
prompt-injection vector.

## Loading

On the first `before_agent_start` (i.e. after the first user message) the
extension appends a block to the system prompt, rebuilt **every turn** from
current on-disk state — toggles apply on the next message, no restart, nothing
to invalidate. Load order: global alphabetically, then project alphabetically.
Each file is wrapped:

```
<user_instruction source="/path/to/file.md">
…body…
</user_instruction>
```

pi's native context files (`AGENTS.md`, `CLAUDE.md`, `APPEND_SYSTEM.md`) are
untouched — this extension only manages the two instructions dirs.

## Usage

```
/instructions                                    # interactive overlay
/instructions enable|disable <name>              # toggle in the file's own scope
/instructions enable|disable <name> --global     # target a specific scope
/instructions enable|disable <name> --session    # this conversation only
/instructions reload                             # rescan + report active counts
```

Overlay keys: `↑↓/kj` move · `space` toggle (persisted) · `s` cycle session
override · `?` help · `esc` close. The view rescans on every render, so file
changes show up immediately — no filesystem watcher.

## Ceiling

Instructions do **not** propagate into Agent-tool subagents; pi does not expose
their system prompt to extensions.

## Self-check

```sh
node test.ts   # exercises scan/frontmatter/state/shadowing/block building
```
