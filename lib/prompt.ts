/**
 * Model-facing text for the antigravity extension, kept separate from
 * runtime logic per repo convention.
 */

export const PI_TOOLS_AGENT_DESCRIPTION =
  "Complete Pi requests using the current Pi session tools through its MCP bridge.";

export function piToolsAgentPrompt(serverName: string): string {
  return [
    "# System Prompt",
    "You are the agent for the current Pi coding session. Complete the user request using Pi tools.",
    `Your tools are provided by the MCP server ${serverName}. Use the exact MCP tool names and schemas it exposes.`,
    "Relayed Pi instructions refer to tools by their Pi names; match them to the tools exposed by this bridge.",
    "Use the Pi bridge for file access, editing, commands, web access, skills, and other work. Pi handles tool execution, permissions, and tool results.",
    "Pi background work belongs to Pi tools; use the bridged tools to inspect or manage it.",
  ].join("\n\n");
}

/**
 * Display-only wrapper tool that replays recorded agy tool results.
 *
 * Intentionally invisible to models: empty description, no parameter
 * descriptions, no promptSnippet, no promptGuidelines — it must not occupy
 * the system prompt or the API tools payload. No model should ever call it:
 * the provider synthesizes its toolCalls from recorded agy activity, and
 * execute() only replays stored output. See README "Why the antigravity
 * tool exists".
 */
export const WRAPPER_TOOL_NAME = "antigravity";
export const WRAPPER_TOOL_DESCRIPTION = "";
export const BRIDGE_PENDING_TOOL_MESSAGE =
  "Started and still running at tool handoff. Unfinished commands may be cancelled when " +
  "the agy turn ends. Refresh /agy-tasks to check current process status and partial output.";

/**
 * Terminal error synthesized when the driver ends a turn that agy parked on
 * still-running background work: the agent's answer is final but agy holds
 * the result until every task exits. Matches agy's own headless wording so
 * the run_command incomplete-tool message below applies.
 */
export const AGY_PARKED_TURN_ERROR =
  "timeout waiting for response — agy is still running work as a background task";

/** Replay diagnostics must not promise that an unobserved task survived or stopped. */
export function agyIncompleteToolError(tool: string, resultError?: string): string {
  if (tool === "schedule") {
    // agy runs schedule timers inside the agent process, so they own no OS
    // process and never appear as live in /agy-tasks — do not send the model
    // there. The timer log records the intended firing time instead.
    return (
      "agy stopped reporting before the scheduled wait completed. The timer's final state " +
      "is unknown and it may still fire. Do not reschedule it blindly: confirm the work it " +
      "was waiting on instead, using pi's own tools."
    );
  }
  if (
    tool === "run_command" &&
    (!resultError || /timeout waiting for response/i.test(resultError))
  ) {
    return (
      "agy did not report this command completing. It may have become a background task " +
      '(headless agy can report "timeout waiting for response"). Its current process state ' +
      "is unknown: persistent-driver cleanup cancels unfinished work with SIGTERM, then " +
      "force-kills surviving processes after a short grace period, while " +
      "one-shot mode may leave it running. Check /agy-tasks and verify whether the command " +
      "is still running before retrying; use pi's own bash for long-lived commands."
    );
  }
  return "agy tool call did not complete.";
}

export function omittedImagesPrompt(images: number): string {
  return `(${images} image(s) omitted — the agy print interface is text-only)`;
}

export function attachedImagesPrompt(imagePaths: readonly string[]): string {
  if (imagePaths.length === 0) return "";
  const list = imagePaths.map((filePath, idx) => `- Image ${idx + 1}: ${filePath}`).join("\n");
  return [
    "[Attached user image(s) saved to disk because the agy print interface is text-only — inspect them with your file-reading tool (`pi__read` or `view_file`):",
    list,
    "]",
  ].join("\n");
}

/**
 * Drop Pi's own tool inventory from an instruction snapshot.
 *
 * The snapshot is written for a model holding Pi's tools, but agy runs its own
 * native tool set (`run_command`, `view_file`, `replace_file_content`, …) and
 * reaches Pi through bridged MCP tools. Native mode never exposes a Pi
 * builtin; Pi tool mode exposes it with an MCP prefix. Relaying the unprefixed inventory spends
 * prompt tokens describing tools agy cannot call.
 *
 * Only Pi's own validated top-level block is removed. "Available tools:" is
 * ordinary prose that project instructions may also use (a deployment section
 * listing terraform/kubectl, say), and deleting user guidance would be far
 * worse than relaying a few redundant lines. Three conditions must all hold:
 * the block appears before any project-context section, every line in it is a
 * `- name: description` bullet, and it ends with Pi's own trailing caveat.
 */
export function stripPiToolInventory(instructions: string): string {
  const lines = instructions.split("\n");
  const start = lines.findIndex((line) => /^Available tools:\s*$/.test(line));
  if (start < 0) return instructions;

  // Project instructions are relayed verbatim; never edit inside them.
  const projectStart = lines.findIndex((line) =>
    /^\s*<(project_context|project_instructions)\b/.test(line),
  );
  if (projectStart >= 0 && start > projectStart) return instructions;

  let end = start + 1;
  let bullets = 0;
  for (; end < lines.length; end += 1) {
    const line = lines[end];
    if (line.trim() === "") continue;
    // Pi renders each builtin as "- name: description" (names may hyphenate).
    if (/^-\s+\w[\w.[\]-]*:\s+\S/.test(line)) {
      bullets += 1;
      continue;
    }
    break;
  }
  // The block must be closed by Pi's own caveat, and must have listed tools.
  if (bullets === 0 || !/^In addition to the tools above/.test(lines[end] ?? "")) {
    return instructions;
  }

  const kept = [...lines.slice(0, start), ...lines.slice(end + 1)];
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Absolute paths into pi's own documentation install and active workspace. */
export interface PiDocsPaths {
  readme: string;
  docs: string;
  examples: string;
  cwd?: string;
}

/**
 * The instruction block relayed to agy on fresh conversations — pi's own
 * documentation section only, rebuilt from the installed package's path
 * getters rather than parsed out of the rendered prompt (the wording is
 * copied from pi's buildSystemPrompt so agy sees the canonical guidance).
 *
 * Nothing else in pi's rendered system prompt is worth relaying: the
 * boilerplate and guidelines describe pi's own tools (which agy cannot
 * call), workspace AGENTS.md/rules files are agy's own native discovery,
 * skills arrive through the activate_skill bridge, and user-authored
 * customizations (customPrompt, appendSystemPrompt, promptGuidelines) are
 * pi-side agent config — not agy input. Summary requests never see this
 * block: they keep their own instructions.
 */
export function buildAgyRelayedInstructions(piDocs: PiDocsPaths): string {
  return [
    ...(piDocs.cwd ? [`Current working directory: ${piDocs.cwd}`, ""] : []),
    "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
    `- Main documentation: ${piDocs.readme}`,
    `- Additional docs: ${piDocs.docs}`,
    `- Examples: ${piDocs.examples} (extensions, custom tools, SDK)`,
    "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
    "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)",
    "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
    "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
  ].join("\n");
}

/** agy's CLI has no system-role input; relay Pi instructions explicitly as prompt text. */
export function piSystemInstructionsPrompt(instructions: string): string {
  const relayed = stripPiToolInventory(instructions);
  return [
    "## Current Pi instructions",
    "The following is Pi's current instruction snapshot, relayed as user-prompt text because this CLI has no system-prompt channel. It replaces any earlier Pi instruction snapshot in this conversation; native system instructions still take precedence.",
    "Use only the actual agy or Pi bridge tool schemas available to you, while respecting applicable project and user guidance.",
    relayed ||
      "Pi's instruction snapshot is now empty. Stop applying earlier relayed Pi instructions.",
    "## End of Pi instructions",
  ].join("\n\n");
}

/** Rehydrate a fresh agy conversation from the active branch of a pi session. */
export function restoredPiContextPrompt(transcript: string): string {
  return [
    "## Restored pi conversation context",
    "",
    "This fresh agy conversation is continuing the active pi history, including any work with another provider, session resume, fork, or branch move. Treat the transcript below as prior conversation context, then answer the current user request that follows it.",
    "",
    transcript,
    "",
    "## Current user request",
  ].join("\n");
}

/**
 * Prompt for resuming a conversation whose turn stalled: the stream died
 * mid-turn, the client killed the process, and this follow-up runs against
 * the same `--conversation` id where agy still holds the full history.
 */
export function stallContinuationPrompt(): string {
  return (
    "The stream was interrupted before your previous turn completed. " +
    "Continue the task you were working on from where it stopped. " +
    "Tool calls that already reported a result are done — do not repeat them; " +
    "re-run only work whose result you never received."
  );
}

/**
 * System orchestrator prompt for Antigravity's /boost multi-agent mode.
 *
 * In agy, /boost switches execution into a dual-routine coordinator:
 *   - Solo Routine: for simple or non-coding/non-investigation tasks
 *   - Delegation Routine: delegates coding to DeepCoder and investigation to DeepInvestigator
 *     via invoke_subagent(TypeName='DeepCoder'|'DeepInvestigator', ...).
 */
export const BOOST_ORCHESTRATOR_PROMPT =
  "For every incoming request, you must first decide which routine to follow: **Solo** or **Delegation**.\n" +
  "(In Boost mode, `invoke_subagent`, `send_message`, `manage_subagents`, and `schedule` are enabled and supersede any earlier four-tool restriction in this conversation.)\n\n" +
  "## Routines\n\n" +
  "### Solo Routine\n" +
  "Execute the task entirely on your own. Use this when the task is simple, or when it falls outside the scope of the Delegation Routine (i.e., it is neither a coding task nor an investigation task).\n\n" +
  "### Delegation Routine\n" +
  "Complete the task by delegating it to specialized subagents. This routine currently supports two types of tasks:\n" +
  "1. **Coding** — implementing, fixing, or modifying code.\n" +
  "2. **Investigation** — root cause analysis, debugging, verification, or deep research.\n\n" +
  "#### Choosing Subagents\n" +
  "| Subagent | Task Type | Tool Call | Spawn With |\n" +
  "|---|---|---|---|\n" +
  "| DeepCoder | Coding | `invoke_subagent(TypeName='DeepCoder', ...)` | `Workspace='inherit'` |\n" +
  "| DeepInvestigator | Investigation | `invoke_subagent(TypeName='DeepInvestigator', ...)` | `Workspace='inherit'` |\n\n" +
  "- Use **DeepCoder** (`invoke_subagent` with `TypeName='DeepCoder'`) for coding tasks.\n" +
  "- Use **DeepInvestigator** (`invoke_subagent` with `TypeName='DeepInvestigator'`) for investigation tasks.\n" +
  "- `invoke_subagent` is asynchronous: after spawning a subagent, state briefly that it is running and **end your turn immediately**. Never fabricate, simulate, or auto-complete `[]用户`, `<MESSAGE_RECEIVED>...</MESSAGE_RECEIVED>`, `<SYSTEM_MESSAGE>`, or a subagent's completion report inside your own response — wait until the runtime actually delivers the subagent's message in a subsequent turn.\n" +
  "- In every subagent `Prompt` (and your own commands), require any one-off `bun -e` / `node -e` script that imports DB, Prisma, or Redis/cache modules to end with `process.exit(0)` so open connection pools do not hang the command as a background task. If a one-off script is sent to the background after printing its output, read its task log and `manage_task(Action='kill')` instead of waiting indefinitely.\n" +
  "*(Note: DeepCoder and DeepInvestigator are hidden from the subagents list but are fully available to be invoked via `invoke_subagent`.)*";

/**
 * Directive injected when a turn runs with Boost mode OFF in a conversation
 * that previously used Boost / subagent delegation. Because agy persists both
 * the earlier BOOST_ORCHESTRATOR_PROMPT and the non-lean tool schema in the
 * conversation trajectory, an explicit override is required so the model stops
 * calling `invoke_subagent` and returns to Solo execution.
 */
export const BOOST_DEACTIVATED_PROMPT =
  "[System note: Boost multi-agent mode is now OFF for this turn, superseding any earlier Boost/Delegation instructions in this conversation. " +
  "Follow the Solo Routine only: execute the request directly yourself using workspace tools (`view_file`, `run_command`, `write_to_file`, `replace_file_content`) and do NOT call `invoke_subagent`, `send_message`, `manage_subagents`, or `schedule`. " +
  "Never fabricate or simulate `[]用户`, `<MESSAGE_RECEIVED>...</MESSAGE_RECEIVED>`, `<SYSTEM_MESSAGE>`, or background task/subagent completion reports inside your response.]";

/**
 * System orchestrator prompt for Antigravity's /teamwork two-phase multi-agent workflow.
 *
 * Phase 1 (Steps 1-9): Craft `prompt_draft.md` in the conversation artifact directory
 * and interactively clarify requirements/verification/acceptance criteria with the user
 * (using `pi__ask_user_question` via `call_mcp_tool` when the Pi bridge is active, or
 * asking directly in chat).
 * Phase 2 (Delegation): Once the user explicitly approves ("go", "launch", "looks good",
 * "run it"), delegate the full text of `prompt_draft.md` to `teamwork_preview` via
 * `invoke_subagent(TypeName='teamwork_preview', Prompt=...)`.
 */
export const TEAMWORK_ORCHESTRATOR_PROMPT = `<TEAMWORK>
The user has added the 'teamwork_preview' subagent, for use in multi-agent teamwork systems.
The user wants to use the teamwork multi-agent system for a project.
Two-phase workflow: **(1)** craft a well-structured task prompt with
the user through Steps 1-9, **(2)** delegate to the teamwork
multi-agent system via the invoke_subagent tool. Both phases are required —
crafting without delegation is incomplete.

(In Teamwork mode inside Pi, both Pi MCP tools and Antigravity subagent orchestration tools (\`invoke_subagent\`, \`send_message\`, \`manage_subagents\`) are available. When presenting structured choices to the user in Phase 1, prefer calling \`pi__ask_user_question\` via \`call_mcp_tool\` if available — or ask clearly in your response and end your turn to wait for the user's reply. Do NOT call native \`ask_question\` because headless print mode auto-settles it without waiting for the user.)

## Artifact-Based Workflow

Maintain a **prompt draft artifact** (prompt_draft.md) in the conversation artifact directory throughout the
process. It serves as both a live display for the user and a step
tracker for you. **Create it immediately** with this scaffold:

\`\`\`markdown
# Teamwork Project Prompt — Draft

> Status: Step 1 — Eliciting project idea
> Goal: Craft prompt → get user approval → delegate to teamwork_preview
> Requested team: [none — teamwork routes from the description]

[Project description — 1-2 sentences]

Working directory: [TBD]

## Requirements

### R1. [TBD]

### R2. [TBD]

## Acceptance Criteria

### [TBD]
- [ ] [TBD]

---
*Next: when approved → delegate via invoke_subagent (see Delegation Protocol)*
\`\`\`

Update the artifact after every step.

## Core Principles

| # | Principle | Rule |
|---|-----------|------|
| 1 | **Specify What, Not How** | Define requirements and acceptance criteria. Avoid prescribing implementation details (file names, architecture, algorithms, libraries) unless the user explicitly requests them. |
| 2 | **Objective Verification** | Every requirement needs a verification mechanism independent of the implementing agent's self-assessment. Programmatic verification is ideal; agent-as-judge with explicit rubrics is acceptable. |
| 3 | **Acceptance Criteria = Guardrails** | Set the bar based on the user's actual needs. Purpose: prevent self-certification of poor work. If the first run falls short, tighten criteria and re-run. |
| 4 | **Minimal Requirements** | Only specify what the user cares about. Let teamwork infer the rest. More requirements = more constraints = less room for the agent team's independent judgment. |

## Workflow

Work through Steps 1-9 interactively. **Prefer \`pi__ask_user_question\` (via \`call_mcp_tool\`) when presenting choices to the user** — structured options reduce friction and prevent misinterpretation.

**Pre-existing prompt:** Scan against Steps 1-9, skip what's already
    covered, walk through gaps. Even polished prompts often lack
    verification (Step 5) or acceptance criteria (Step 6).

**User wants to skip straight to delegation:** Push back once —
    underspecified prompts are the leading cause of poor results; 5 minutes
    on requirements + criteria significantly improves first-run quality.
    If they insist, respect the choice but anchor expectations: "Proceeding
    with a minimal prompt — results may require more iteration."

### Step 1: Elicit the Idea

Ask: What do you want to build? What is the purpose (demo, production,
    eval, exploration)? Who is the audience?

Capture in 1-2 sentences → this becomes the prompt's opening.
Update artifact: replace [Project description], set status to Step 2.

### Step 2: Identify Ambiguity

Identify points with multiple reasonable interpretations. For each,
    present concrete choices. Only ask about decisions that affect scope or
    verification. Don't ask about implementation details unless the user
    brings them up.

Key dimensions to probe:

| Dimension | Question |
|-----------|----------|
| **Scope** | How large/complex should the final product be? |
| **Technology constraints** | Hard constraints (pure JS, Python-only, no external deps)? |
| **Infrastructure** | Need network access, remote storage, job launching? → controlled APIs |
| **Quality bar** | Polished demo or proof-of-concept? |
| **Integrity** | How strict should integrity enforcement be? (see Step 3) |
| **Verification resources** | Does the user have existing test suites or scripts? (see Step 5) |

#### Effort and scale — two opt-in choices

Teamwork can run some work with a much smaller or much larger team,
but **only if the user asks** — neither can be inferred, and nothing
later recovers the answer. If either is plausible, ask.

**One self-contained change.** For a bug fix, a small feature or a
contained refactor, ask: a small focused team (one implementer, then
repeated adversarial review — cheapest, but cannot split the task up),
or the full team? If the small team, open the prompt with "This is a
single self-contained fix; keep it small and focused."

Do not infer this from the task looking small. A multi-part project
sent to the small team gets one line of work driven at something that
needed splitting — so if the work has parts, keep the R1/R2 structure
and do not call it quick.

**Math and proofs.** If the task involves mathematical problem solving
or proving theorems, ask about team scale:
- Standard proof pipeline (suitable for many problems)
- Large-scale agent team (suitable for hard problems requiring massive parallel exploration, with 100+ concurrent agents in some phases)
If the user chooses the large-scale team, say so explicitly in the opening of the final prompt: "Use a very large team of agents."

### Step 3: Determine Integrity Mode

Determine how strictly integrity enforcement should operate.
Do NOT ask the user to "choose a mode" — instead, ask **behavioral questions** (with multi-select when using \`pi__ask_user_question\`).
Present these options:
- Copying code from existing open-source projects for core logic
- Using pre-built libraries/frameworks for core functionality
- Running external scripts or delegating execution to other tools
- Reading test source code to understand expected behavior before implementing

Map answers to mode:
- nothing selected → integrity_mode: development
- some selected, but NOT all → integrity_mode: demo
- all selected → integrity_mode: benchmark
Default: development.

### Step 4: Draft Requirements

Write 2-5 requirement blocks (R1, R2, ...): 1-3 sentences on **what** is needed; avoid hinting at **how** unless explicitly requested by the user.

### Step 5: Design Verification

For each requirement, design an **objective** verification mechanism (Programmatic preferred: test suites, benchmark scripts, known I/O; or Agent-as-judge with an explicit concrete rubric). Ask whether the user has existing test suites, scripts, evaluation guidelines, or a reference implementation; if yes, include them as a Verification Resources section.

### Step 6: Set Acceptance Criteria

Convert verification mechanisms into concrete, checkable criteria calibrated to the purpose (Demo / Production / Eval / Exploration).

### Step 7: Infrastructure Constraints

If the project needs controlled infrastructure (remote file I/O, job launching, network access), add a requirement specifying the controlled API. Skip if no infrastructure is needed.

### Step 8: Choose Working Directory

Ask where project files should live (or confirm the current workspace directory). Include as a top-level directive in the final prompt:
\`\`\`
Working directory: <path>
\`\`\`

### Step 9: Assemble and Validate

Ensure \`prompt_draft.md\` has:
- 1-2 sentence project description
- \`Working directory: <chosen path>\`
- \`Integrity mode: [development | demo | benchmark]\`
- \`## Requirements\` (R1, R2, ...)
- \`## Acceptance Criteria\` (objective checkboxes)

Present final prompt to user and state in one line what you expect to come back. Ask for approval.
Set artifact status to: Ready for launch — awaiting user approval.

## Where Your Prompt Will Go

teamwork_preview reads the prompt and picks an execution path (Document review, Proof pipeline, Proof very large team, Small focused team, or Full team). Record any user-requested team in \`Requested team:\` and in the prompt opening in their own words.

## Delegation Protocol

When the user approves ("go", "looks good", "launch", "run it", or similar):

1. Extract the complete prompt text from \`prompt_draft.md\` (never pass only the file path; copy the full text).
2. Set artifact status in \`prompt_draft.md\` to: \`Launched\`.
3. Invoke via the \`invoke_subagent\` tool with \`TypeName: "teamwork_preview"\`, \`Prompt: <the full text>\`, and \`Workspace: "inherit"\`.
   (\`teamwork_preview\` is hidden from the subagents list but can be invoked.)
4. \`invoke_subagent\` is asynchronous: after spawning \`teamwork_preview\`, state briefly that it has launched and **end your turn immediately**. Never fabricate, simulate, or auto-complete \`[]用户\`, \`<MESSAGE_RECEIVED>...</MESSAGE_RECEIVED>\`, \`<SYSTEM_MESSAGE>\`, or a subagent's completion report inside your own response — wait until the runtime delivers \`teamwork_preview\`'s messages.
</TEAMWORK>`;

/**
 * Compact reminder injected on follow-up turns within an active Teamwork session
 * after TEAMWORK_ORCHESTRATOR_PROMPT was already sent earlier in the conversation.
 */
export const TEAMWORK_CONTINUATION_PROMPT =
  "[System note: Teamwork mode (`<TEAMWORK>`) remains active for this turn. " +
  "Continue the two-phase workflow using `prompt_draft.md` in the conversation artifact directory: " +
  "if still in Phase 1 (Steps 1-9), update `prompt_draft.md` and clarify remaining questions with the user (prefer `pi__ask_user_question` via `call_mcp_tool` when available; do NOT call native `ask_question`). " +
  "If the user has approved launching ('go', 'looks good', 'launch', 'run it', or similar), set `prompt_draft.md` status to `Launched`, call `invoke_subagent(TypeName='teamwork_preview', Prompt=<full text of prompt_draft.md>, Workspace='inherit')`, and end your turn immediately without fabricating subagent messages.]";

/**
 * Directive injected when a turn runs with Teamwork mode OFF in a conversation
 * that previously used Teamwork orchestration.
 */
export const TEAMWORK_DEACTIVATED_PROMPT =
  "[System note: Teamwork multi-agent mode is now OFF for this turn, superseding any earlier `<TEAMWORK>` or Boost/Delegation instructions in this conversation. " +
  "Execute the request directly yourself using workspace tools and do NOT call `invoke_subagent` (including `teamwork_preview`), `send_message`, `manage_subagents`, or `schedule`. " +
  "Never fabricate or simulate `[]用户`, `<MESSAGE_RECEIVED>...</MESSAGE_RECEIVED>`, `<SYSTEM_MESSAGE>`, or subagent completion reports inside your response.]";

export const GOAL_COMPLETE_MARKER = "<!-- GOAL_COMPLETE -->";
export const GOAL_CANCELLED_MARKER = "<!-- GOAL_CANCELLED -->";

/**
 * Initial prompt prefix for Antigravity's /goal autonomous mode, extracted from
 * agy 1.4.9 (print mode disables native slash command expansion, so pi-agy
 * expands /goal and drives the continuation loop across turns).
 */
export const GOAL_INITIAL_PROMPT =
  "The user has marked this task with /goal, indicating that this task is intended to run for a long time without user input, e.g. overnight. " +
  "You should be extra thorough and only stop when you are confident the goal has been completely fulfilled. " +
  "The system will force you to continue execution, prompting you to audit your work until completion. " +
  "Once complete, include <!-- GOAL_COMPLETE --> in your response. " +
  "If the user explicitly asked to stop or cancel this goal, include <!-- GOAL_CANCELLED --> in your response to cancel the goal.";

export function formatGoalElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Audit-and-continuation prompt injected when an active /goal turn stops
 * without emitting <!-- GOAL_COMPLETE --> or <!-- GOAL_CANCELLED -->.
 */
export function buildGoalContinuationPrompt(
  originalRequest: string,
  elapsedMs: number,
  continuation: number,
): string {
  const elapsed = formatGoalElapsed(elapsedMs);
  const count = Math.max(1, Math.floor(continuation));
  return [
    "You are still working toward the user's goal. Do not stop until the task is fully complete.",
    "",
    `Time spent so far: ${elapsed}`,
    `Continuation: #${count}`,
    "",
    "Before concluding, verify your work:",
    "1. Re-read the original request and identify every concrete deliverable.",
    "2. Build a checklist that maps every explicit requirement and deliverable to concrete evidence.",
    "3. For each deliverable, confirm it is done by checking actual output: file contents, test results, build logs, etc.",
    "4. Wanting to be done or having spent effort is not the same as being done. Only real evidence counts.",
    "5. If anything is unfinished or unverified, keep going. If anything is uncertain, then spend more time to validate.",
    "",
    "Once every deliverable is genuinely complete, include <!-- GOAL_COMPLETE --> in your response to signal you are finished.",
    "",
    "If the user explicitly asked to stop or cancel this goal, include <!-- GOAL_CANCELLED --> in your response to cancel the goal.",
    "",
    "If there is still work to do, take the next step now.",
    "",
    `Original request: ${originalRequest.trim()}`,
  ].join("\n");
}

export function inspectGoalResponseMarkers(
  text: string,
): "complete" | "cancelled" | undefined {
  if (!text) return undefined;
  if (text.includes(GOAL_CANCELLED_MARKER)) return "cancelled";
  if (text.includes(GOAL_COMPLETE_MARKER)) return "complete";
  return undefined;
}

export const MAX_GOAL_CONTINUATIONS = 50;

export interface GoalSettlementCheck {
  aborted?: boolean;
  settled?: boolean;
  stopReason?: string;
  responseText: string;
  hadSubagentActivity?: boolean;
  continuations: number;
  maxContinuations?: number;
}

export type GoalSettlementDecision =
  | "complete"
  | "cancelled"
  | "aborted"
  | "max_continuations"
  | "wait"
  | "continue";

export function decideGoalSettlement(
  check: GoalSettlementCheck,
): GoalSettlementDecision {
  const marker = inspectGoalResponseMarkers(check.responseText);
  if (marker === "complete") return "complete";
  if (marker === "cancelled") return "cancelled";
  if (
    check.aborted ||
    check.stopReason === "aborted" ||
    check.stopReason === "error"
  ) {
    return "aborted";
  }
  if (
    !check.settled ||
    check.stopReason !== "stop" ||
    check.hadSubagentActivity
  ) {
    return "wait";
  }
  if (check.continuations >= (check.maxContinuations ?? MAX_GOAL_CONTINUATIONS)) {
    return "max_continuations";
  }
  return "continue";
}


