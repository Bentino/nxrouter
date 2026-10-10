# NX Router

NX Router is a lightweight adaptive intelligence and safety layer for VS Code coding-agent workflows. It uses VS Code Chat, an OpenAI router, and a bounded coding worker loop. It is designed to avoid unnecessary high-tier model use while preserving safety and verification quality; measured savings are not yet available.

## What it does

For each configured `@nx` turn, the selected Router model proposes LOW, MEDIUM, or HIGH. A deterministic Risk Gate can raise that route. The selected worker reads relevant code, uses bounded workspace tools, and may escalate when runtime evidence reveals a qualitative change in complexity or risk. NX retains compact session context so short follow-ups can continue the task.

## Why and architecture

VS Code provides Chat, references, workspace APIs, diffs, and native tool approval. NX provides compact state, routing, risk floors, selective context enrichment, a bounded worker/tool loop, escalation, and local usage telemetry. The current `@nx` entry uses a shared NxRuntime, with a provider profile and the existing VS Code Language Model bridge. The NX Router Sidebar provides locally saved workspace chats, recent history/search, live responses, Send/Stop, session-backed Auto and catalog-backed Manual controls, explicit bounded workspace context with removable chips, safe Markdown/code, expandable runtime-backed tool activity and factual applied-file counts alongside connection and native settings actions. It is not a full Cursor or Cline replacement.

```text
Sidebar / @nx adapters → NxRuntime → selected provider profile → Router/Risk Gate → worker
                                              → reviewed tools → telemetry
```

## Requirements and first use

Use Microsoft VS Code 1.140 or newer with Chat and the Language Model API available, a trusted single local workspace, and an eligible ChatGPT connection. NX discovers selectable models from the connected account; it does not assume a fixed model catalog. Complete the four model mappings before using production Auto routing. A missing worker model stops the turn and does not downgrade. Version **0.1.0** is the first implementation-complete MVP v4 release with final authenticated acceptance pending; see the [UI-08 readiness report and consolidated live checklist](docs/ui-08-production-readiness-benchmark.md).

1. Run `npm ci`, then `npm run compile`.
2. Press **F5** to launch the Extension Development Host, or install the built extension through your normal VS Code extension workflow.
3. Run **NX Router: Connect OpenAI** from the Command Palette and finish browser authorization. ChatGPT plan usage must be granted.
4. Run **NX Router: Configure OpenAI Models** to select account-available Router, LOW, MEDIUM, and HIGH models, then **NX Router: Test OpenAI Connection**.
5. Open the **NX Router** Activity Bar icon and select **New Chat**. Enter sends; Shift+Enter inserts a newline. **Stop** cancels the running turn and keeps partial text.
6. Auto defaults ON when all mappings are valid. Turn Auto OFF to choose a discovered model manually; current OpenAI effort is **Default** only, so the effort picker stays hidden. Review native tool approvals and exact diff **Apply/Cancel** prompts for edits. `@nx` remains available in VS Code Chat through the same runtime.
7. Use **+ Context** in the composer for Current file, Current selection, Files..., Diagnostics or Git diff. **Files...** can explicitly attach UTF-8 text or PNG/JPEG screenshots from inside or outside the workspace. Images are sent as image inputs (5 MiB each, 10 MiB combined; up to 8192 × 8192). Files/diagnostics/diff refresh at Send; selections keep the explicitly attached snapshot. Chips belong to the next turn and can be removed. Local history keeps safe descriptors only, and reopening never resends attachments automatically. Limits are 8 items; text allows 16,000 characters each and 48,000 combined; Git includes tracked staged/unstaged worktree changes relative to HEAD, excluding untracked/binary files. See [UI-06 context and attachments](docs/ui-06-context-attachments.md).
8. Chats are saved automatically in local extension storage for this trusted single-root workspace. Home shows Recent chats; View all searches titles/user text locally and lets you reopen or delete an individual chat with confirmation. New Chat settles active work, saves meaningful content and starts fresh without empty-history spam. Reload restores the last meaningful chat; interrupted work is labelled Interrupted and never resumes automatically. A new turn uses validated compact continuity and current provider/model availability.

When multiple implemented providers are linked, the composer offers explicit provider selection. **Continue fresh** keeps local history while starting a new provider segment with no previous-provider conversation or rolling state. **Carry selected context** requires explicit reference selection and destination consent; **Start new chat** creates a separate session. Auto routing and escalation always stay within the selected provider; failures never switch providers. The picker stays hidden with one usable provider. OpenAI is the only production provider; second-provider verification uses isolated test fixtures. See [UI-07 provider switching](docs/ui-07-provider-switching-boundary.md) for schema v3 compatibility, carry/privacy semantics, verification and pending authenticated checks.

## Usage and routing levels

LOW handles bounded mechanical edits and read-only checks. MEDIUM handles normal implementation, debugging, and investigation. HIGH handles architecture, access control, populated data changes, consequential writes, and production mutation risk. A production read-only investigation can remain MEDIUM. Use `@nx /low`, `@nx /medium`, or `@nx /high` to request a route for one turn; the Risk Gate can raise LOW or MEDIUM. The chat shows the selected route and any safety upgrade or runtime escalation, such as `NX · MEDIUM → HIGH`.

The worker output is followed by an NX summary of observed changed targets, successful verification, unverified changes, and remaining issues. NX does not infer test success from model prose.

## Safety model and production tools

The Risk Gate applies code-defined minimum routes. Production tool identities separate SAFE read/search/diagnostics/git inspection, WRITE create/edit/move/copy, and EXECUTE verification. Writes use native approval and an exact diff or target review before applying. Execution uses a narrow allowlist, an argument vector without a shell, a timeout, and cancellation. Tools stay inside one local workspace. Production delete, destructive git, production mutation, unrestricted shell, and external filesystem targets are unavailable. A HIGH route does not grant those operations.

## Dynamic escalation

After a completed tool result, NX can raise LOW → MEDIUM/HIGH or MEDIUM → HIGH when bounded runtime evidence supports a material change. A higher worker receives a compact factual handoff. There is no automatic downgrade or extra router call for the escalation. If the required higher model is unavailable, NX stops with a clear error.

## Telemetry and privacy

Telemetry is optional and local-only in VS Code extension **global storage**. It records metadata such as model IDs, route, token counts when available, tool name/outcome, timings, and rule IDs. It does not persist raw prompts, source code, model responses, tool output, or credentials. During an active turn, the model provider and tools still process the task and relevant source context; telemetry privacy does not describe provider-side handling.

Use Command Palette commands **NX Router: Telemetry Status**, **Export Latest Session Telemetry**, **Clear Latest Session Telemetry**, **Clear Workspace Telemetry**, and **Clear All Telemetry**. Clear commands ask for confirmation. “Latest session” means the latest NX session (Sidebar or `@nx`) handled by this extension host; VS Code does not expose a reliable focused Chat session ID to these commands. Export opens versioned metadata-only JSON with records and an aggregate summary. Observed model token counts are not provider-reported exact usage; unavailable values and partial coverage are explicit. Session identities refresh on actual turns so resumed chats remain clearable after retention or an earlier clear. Estimated API-equivalent cost is `unavailable` unless verified pricing and token counts exist; it is not actual billing. Disabling telemetry stops new records without affecting routing or worker behavior.

## Settings

The production settings below are contributed by `package.json`. Tool and OpenAI model settings use VS Code **user/application** scope. Telemetry settings can be set at **user or workspace** scope; a workspace override affects that workspace. Invalid numeric values outside the listed bounds fall back to a safe default. OpenAI model mappings are visible in native User Settings, configured through **NX Router: Configure OpenAI Models**, and shown by **NX Router: OpenAI Connection Status**.

| Setting | Default | Purpose and safety |
| --- | --- | --- |
| `nxRouter.telemetry.enabled` | `true` | Record local metadata only. |
| `nxRouter.telemetry.retentionDays` | `90` | Retain 1–3650 days; cleanup runs at activation and after setting changes. |
| `nxRouter.execution.timeoutSeconds` | `30` | Default allowlisted command timeout, 1–120 seconds. |
| `nxRouter.tools.maxReadChars` | `65536` | Per-file UTF-8 byte bound for read/edit/search, 1024–65536. |
| `nxRouter.tools.maxSearchResults` | `30` | Search result bound, 1–100. |
| `nxRouter.providers.openai.routerModel` | empty | Router model from the current account catalog. |
| `nxRouter.providers.openai.lowModel` | empty | LOW worker model from the current account catalog. |
| `nxRouter.providers.openai.mediumModel` | empty | MEDIUM worker model from the current account catalog. |
| `nxRouter.providers.openai.highModel` | empty | HIGH worker model from the current account catalog. |

The connected OpenAI path uses chosen model IDs and provider default effort. All four settings must match the active account catalog for Auto to be available; a missing model never triggers model substitution. Account switching revalidates the same user-level mappings. VS Code workspace/folder overrides are ignored by the runtime. The account model catalog currently does not reliably advertise supported reasoning effort values, so NX does not invent low, medium, or high effort options. The old `nxRouter.models.*` settings are no longer contributed by the production VSIX; they remain in the isolated development fixture manifest for VS Code LM bridge tests. Safety rules, operation policy, and escalation rules are not user settings.

## Current limitations

Live ChatGPT sign-in, discovery of seven selectable models, and inference through the repaired Responses text-stream path succeeded in a normal VS Code profile. A first authenticated `@nx` Router/worker turn completed a read-only README summary but exposed a false production escalation. A second authenticated run confirmed the escalation fix and exposed redundant AGENTS path searches and overlapping README reads. After tool-schema and continuation-metadata corrections, the final authenticated smoke completed at MEDIUM with direct README reads at 1–200 and 70–200, no search or escalation, and a correct answer. The second read continued after the first result's 8,000-character cap. Model IDs depend on the connected ChatGPT account. Exact token counts and subscription billing cost are unavailable. Sidebar chats persist per local workspace; the participant independently uses native history/metadata. Unsupported/no-workspace contexts remain ephemeral. Local history has no cloud sync or automatic retention. Defensive size limits and current evidence are documented in UI-05. Commands can only identify the latest NX session handled by the extension host. Evidence extraction is intentionally conservative. Remote and multi-root workspaces, Claude/Gemini providers, production destructive tools, and full autonomous background execution are outside the MVP. Some native approval clicks remain manual smoke checks.

## Development and tests

For an isolated offline fixture, launch the development test host and set `nxRouter.worker.fixtureModels` to `true` there. The production manifest does not contribute fixture models or spike tools. It is a test mode, not a normal user setting. The router still uses its production selection path and may take the documented MEDIUM fallback when Luna is unavailable.

From the repository root, install dependencies, run the automated tests, and build the VSIX. `npm test` compiles TypeScript before running the tests:

```bash
npm ci
npm test
npx @vscode/vsce package --no-dependencies --out nx-router-0.1.0.vsix
```

Install or replace the extension in VS Code using the `code` CLI:

```bash
code --install-extension ./nx-router-0.1.0.vsix --force
```

Then run **Developer: Reload Window** from the VS Code Command Palette to load the updated extension. The commands above use the current `0.1.0` version; update the VSIX filename when changing versions.

Run `npm run check` and `npm test`. The test script checks Responses streams and offline benchmark reporting/disposable-case validators, then launches an isolated Extension Development Host with a test-only manifest and exercises IMP-01 through IMP-08, UI-00, mocked UI-01 connection tests, UI-01B runtime stabilization fixtures, UI-02 Sidebar tests, UI-03 chat/runtime/cancellation tests, UI-04 presentation/applied-result tests, UI-05 persistence/history/integrity tests, UI-06 context/security/migration tests, UI-07 provider boundary/carry/provider-local execution tests, and UI-08 telemetry/contained enrichment/performance checks. `node scripts/test-sidebar-ui.cjs --vsix nx-router-0.1.0.vsix` installs the actual archive into a disposable profile, verifies activation/fixture registry isolation and checks the shipped thread/composer Webview in an isolated production-contribution host, including safe Markdown/code/full-response Copy, draggable and keyboard-adjustable conversation/input division, activity/status, execution switches, focus/caret/scroll preservation, narrow width, zoom and themes. `node scripts/test-sidebar-restart.cjs` verifies two actual disposable hosts against the same profile/workspace using a temporary fake provider and production contributions; it does not establish authenticated OpenAI restart behavior. `node scripts/test-native-review.cjs` exercises production native create/edit Apply/Cancel, copy/move review, allowlisted verification and dangerous-command denial in a disposable workspace. `python3 scripts/inspect-vsix.py nx-router-0.1.0.vsix` asserts archive contents and production gates. `node scripts/test-host.cjs --ui` opens a separate host for manual Chat approval and diff review; `nxRouter.worker.fixtureModels` should be enabled only there. See [UI-06 context and attachments](docs/ui-06-context-attachments.md) for budgets, provenance, descriptor migration, visual/restart/package evidence and pending authenticated checks; [UI-05 sessions and history](docs/ui-05-chat-sessions-history.md) for storage/privacy limits, automated restart evidence and the pending authenticated reload checklist; [UI-04 presentation and tool activity](docs/ui-04-chat-presentation-tool-activity.md) for screenshots, security design, package evidence and the pending authenticated reload checklist; [UI-03 chat and execution controls](docs/ui-03-chat-thread-composer-execution.md), [UI-02 Sidebar shell](docs/ui-02-sidebar-shell-first-run.md), [UI-01B stabilization](docs/ui-01b-runtime-live-smoke-stabilization.md), [UI-01 connection and model setup](docs/ui-01-openai-connection-and-model-setup.md), [UI-00 runtime/provider boundary](docs/ui-00-runtime-provider-boundary.md), and [Plan v4](docs/nx-router-vscode-extension-mvp-plan-v4.md).

## Local benchmark and final acceptance

The development checkout includes six disposable cases and an offline reporter for **NX Auto versus an explicitly selected fixed-model Manual control**, using the same runtime/tools/safety and deterministic acceptance. Run `npm run test:benchmark`; follow [the local benchmark protocol](benchmarks/README.md) in the checkout. `scripts/benchmark-workspace.cjs` prepares fresh disposable baselines and verifies protected files/results; `scripts/benchmark-report.cjs` joins exported telemetry with an external manifest and produces JSON/Markdown. No production benchmark mode, task ID, prompt hash or second telemetry store exists. Benchmark files/tests/evidence and source maps are excluded from the VSIX.

**Real benchmark results are pending.** Synthetic inputs verify tooling only. Failed jobs are never a resource win; unknown usage stays unavailable, and no monetary/subscription savings are claimed. [UI-08](docs/ui-08-production-readiness-benchmark.md) records final architecture/security/privacy/package/migration/accessibility evidence and one consolidated normal-profile live checklist. Reload the installed extension before that checklist. Multi-provider verification remains fixture-only; OpenAI is the only production provider.

MVP v4 ends at UI-08. Additional providers, remote support and other possible extensions remain unscheduled; no next architecture phase or Plan v5 is started.

## License

Copyright (c) 2026 Thitipat. Licensed under GPL-3.0-only. See [LICENSE](LICENSE).
