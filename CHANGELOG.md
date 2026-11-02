# Changelog

## [1.1.0] - 2026-11-02

### Added

- **Grill design-interview mode (`/grill-me`, `/grill`, `/agy-grill`)**: Stress-test plans and designs in dependency-ordered frontier rounds before writing code — automatically using `pi__ask_user_question` TUI cards when available on the Pi bridge or falling back to structured Markdown rounds (`❓ **Q1**` + `➡️ *Recommended*:`) with zero external dependencies.
- **Teamwork multi-agent mode (`/teamwork`, `/agy-teamwork`)**: Two-phase collaborative prompt crafting (`prompt_draft.md`) and `teamwork_preview` autonomous team execution, plus live multi-line subagent progress and diff previews.
- **Goal autonomous mode (`/goal`, `/agy-goal`)**: Long-horizon audit-and-continuation loop until `<!-- GOAL_COMPLETE -->` or `/goal off`.
- **Pi tools mode by default (`/agy-tools`)**: Expose active Pi built-in, extension, and MCP tools eagerly to `agy` through a session-scoped bridge while preserving `agy` specialty tools and image attachments.
- **2-row custom footer (`/agy-footer`)**: Live Antigravity 300k scheduling / 1.0M Claude context bar, cache-hit rate, and provider-aware branch footprint tracking across `/compact` and `/m` consults.
- **Cross-provider `/m` consults & model switching**: Consult any configured Pi `provider/model` for one turn, or omit the prompt to switch models/efforts directly.
- **Session lifecycle sync (`/rename`, `/resume`)**: Sync session renames (`Ctrl+R` and `/rename`) to `agy` conversation titles, and recursively clean up linked `agy` conversations and subagent trees on `/resume` `Ctrl+D` delete (scoped safely by `sessionId` on forked sessions).

### Changed

- **Row 1 footer label clipping & model display priority**: Automatically clip overlong `gitBranch` and `sessionName` with `…` (while stripping inner ANSI resets to preserve styling) and prioritize keeping the `Model • thinkingLevel → routedModel` label intact on narrow terminals or deep directory paths.
- **Pi 1.5.0 compatibility**: Strip structured `<tools>...</tools>` sections (including Pi 1.5.0's tightened `"Additional tools may be available."` wording) when relaying Pi instructions to `agy`, align relayed `<docs>` paths (`docs/mcp.md`, `docs/codemode.md`), and use injected `context.keyHint("app.tools.expand", "to expand")` in tool result renderers.
- Default `agy` invocation to `--model <base> --effort <level>` with automatic fallback to legacy model-effort suffixes; bump recommended `agy` version to `1.4.9+`.

### Fixed

- Handle `agy` 1.4.11 `finished_reason` (`print_timeout`, `interrupted`, `error`) without swallowing partial-output or hook errors.
- Prevent `unhandledRejection` crashes when a turn stalls while a `>64KB` stdin write awaits drain, and preserve user prompts when resumed conversations stall before `init`.
- Preserve user highlight position in `/model` when background model catalog refresh completes.

## [1.0.0] - 2026-10-18

### Features

- **Persistent Antigravity stream-json driver**: Reuse a single `agy` process across user turns with automatic recycling on model, workspace, agent, mode, or bridge changes.
- **One-shot model & effort consult (`/m`, `/consult`, `/agy-consult`)**: Consult any Antigravity model (`opus`, `sonnet`, `argon`, `flash`) with optional thinking effort suffixes (`1`=low, `2`=medium, `3`=high) for a single turn without changing the active session model, displaying a `Consulted <Model> (<effort>)` badge.
- **Boost multi-agent orchestration (`/boost`, `/agy-boost`)**: Delegate complex coding to `DeepCoder` and investigation to `DeepInvestigator` via `invoke_subagent`, automatically restoring Solo execution (`BOOST_DEACTIVATED_PROMPT`) when toggled off, and stripping hallucinated `<MESSAGE_RECEIVED>` turn boundaries.
- **Clear conversation (`/clear [prompt]`)**: Reset the active `agy` conversation and start a fresh Pi session in one step.
- **Live SQLite thinking stream & interactive dashboards**: Stream real-time reasoning traces from `agy`'s SQLite state (`lib/agy-thoughts.ts`) and provide interactive TUI dashboards for `/agy-tasks`, `/agy-artifacts`, `/agy-subagents`, and `/agy-usage`.
- **Skills & MCP bridge**: Expose Pi-private skills via `pi__activate_skill` and bridge Pi's built-in direct-exposure MCP tools into `agy`.
- **Isolated side-conversations**: Run Pi compaction, branch summaries, and `/btw` side-threads in disposable isolated `agy` runtimes without interrupting or polluting the main conversation.
