# pi-agy

## 1.0.0

### Features

- **Persistent Antigravity stream-json driver**: Reuse a single `agy` process across user turns with automatic recycling on model, workspace, agent, mode, or bridge changes.
- **One-shot model & effort consult (`/m`, `/consult`, `/agy-consult`)**: Consult any Antigravity model (`opus`, `sonnet`, `argon`, `flash`) with optional thinking effort suffixes (`1`=low, `2`=medium, `3`=high) for a single turn without changing the active session model, displaying a `Consulted <Model> (<effort>)` badge.
- **Boost multi-agent orchestration (`/boost`, `/agy-boost`)**: Delegate complex coding to `DeepCoder` and investigation to `DeepInvestigator` via `invoke_subagent`, automatically restoring Solo execution (`BOOST_DEACTIVATED_PROMPT`) when toggled off, and stripping hallucinated `<MESSAGE_RECEIVED>` turn boundaries.
- **Clear conversation (`/clear [prompt]`)**: Reset the active `agy` conversation and start a fresh Pi session in one step.
- **Live SQLite thinking stream & interactive dashboards**: Stream real-time reasoning traces from `agy`'s SQLite state (`lib/agy-thoughts.ts`) and provide interactive TUI dashboards for `/agy-tasks`, `/agy-artifacts`, `/agy-subagents`, and `/agy-usage`.
- **Skills & MCP bridge**: Expose Pi-private skills via `pi__p<pid>__activate_skill` and bridge Pi's built-in direct-exposure MCP tools into `agy`.
- **Isolated side-conversations**: Run Pi compaction, branch summaries, and `/btw` side-threads in disposable isolated `agy` runtimes without interrupting or polluting the main conversation.
