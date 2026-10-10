# Local Auto versus fixed-model protocol

Real authenticated benchmark results: **PENDING**. Synthetic metadata tests validate the reporter only. No resource, monetary, or subscription savings have been established.

The question is whether NX Auto completes the same job correctly using fewer model resources than an explicitly chosen fixed-model Manual control. Both use the same NxRuntime, tools, Risk Gate, native reviews and acceptance checks. Auto's Router overhead, retries, unsuccessful requests and escalation are included. The hypothesis can fail: Auto can use more resources or fail acceptance.

## Six disposable jobs

[cases.json](cases.json) is the authoritative prompt/category/allowed-change list. `scripts/benchmark-workspace.cjs` generates dependency-free baselines outside the important working tree. It never removes or overwrites an existing destination. Its external verifier checks both deterministic results and protected baseline files, including tests and package scripts. Do not rely only on model prose or an editable test passing.

| Case | Category | Deterministic acceptance |
| --- | --- | --- |
| mechanical | LOW mechanical edit | Exact JSON change; other fields/files preserved |
| implementation | MEDIUM implementation | Numeric validation, duplicates, ordering, empty input, no mutation |
| debug | MEDIUM investigation | One-based pagination including final/empty/out-of-range pages |
| contract | HIGH contract specification | Exact shared boundary contract; consumers unchanged |
| escalation | Discovered architecture evidence | VBO/DraggableViews conflict in a `.conf` source; both order modes and ties |
| safety | Safe handling | Policy-denied assessment, sentinel unchanged, no destructive execution |

These small jobs provide controlled breadth, not a representative estimate of all coding work. The contract case checks a structured contract artifact rather than subjective design quality. The escalation case must **observe** its initial route and transition: if it starts HIGH or never escalates, record that and do not call it live escalation evidence. Existing deterministic runtime tests independently prove LOW→MEDIUM/HIGH, canonical VBO MEDIUM→HIGH and denial after escalation. The safety benchmark explicitly forbids executing its example; it measures safe handling. Actual policy denial is covered separately by disposable production-tool tests.

## Run discipline

1. Record the repository commit (`git rev-parse HEAD`), actual extension version and VSIX SHA-256, Node/VS Code/platform versions, actual OpenAI catalog and all four mapping IDs. Also hash this protocol/cases/tooling revision if it is dirty. Keep identical records for both arms. No inference is made by the setup/report scripts.
2. Explicitly choose a currently available fixed MEDIUM-class or HIGH-class model and record its ID/confirmed effort. Run separate pairs for separate controls. Model tiers are the operator's configuration, not a name/pricing heuristic. Record the exact `premiumModels` classification, including an explicit empty array if none is classified. A missing model invalidates the configuration: never substitute. Current OpenAI uses default effort (omit `effort`).
3. Prepare a fresh disposable workspace:

   ```bash
   node scripts/benchmark-workspace.cjs prepare implementation
   ```

   Save its returned baseline hashes. Open that directory as the trusted single-root VS Code workspace. Use the same tool timeout/read/search settings, editor state, attachments (normally none) and native approval decisions for both arms. Disable unrelated extensions for repeatability. Never benchmark in the important dirty working tree.
4. Start a meaningful new Sidebar session in Auto. Send the **exact** prompt from cases.json. Do not add coaching, route overrides, hidden context or follow-up repairs to one arm alone. If a whole job needs multiple turns, predeclare the same follow-up procedure for both, record every turn, and retain the complete session export. Record deviations rather than hiding them.
5. Run the external verifier from the development checkout:

   ```bash
   node scripts/benchmark-workspace.cjs verify implementation /tmp/ACTUAL_DISPOSABLE_DIRECTORY
   ```

   Save its JSON/stdout or failure externally. A failed verifier means `accepted:false`. Review the visible result for factual safety/reporting failures too; record human review separately where needed. Keep model request outcome and job acceptance separate: a partial runtime turn can pass deterministic acceptance, while a Completed answer can fail it.
6. Export **Latest Session Telemetry** immediately after that job; save the JSON outside the workspace. Record its `session_id`. Do not export an unrelated subsequent session. No transcript is needed. Avoid clearing all personal telemetry; each new session has its own export. Export while telemetry is enabled.
7. Prepare another entirely fresh directory for the SAME case. Compare returned `fixtureSha256` and `workspaceSha256`: they must match. Open it, start a separate chat, turn Auto OFF and choose the recorded control explicitly. Execute the exact prompt, same approvals, same external verifier, then export separately. Manual must have zero Router requests.
8. Fill an external run manifest, then run:

   ```bash
   node scripts/benchmark-report.cjs /tmp/runs.json /tmp/report.json /tmp/report.md
   ```

9. Repeat paired runs if desired; randomize or counterbalance arm order to reduce warmup/order effects. Use a distinct external `pairId` per replicate/control. Record provider outages and invalid configurations, not just successful runs. One pair establishes no statistical confidence. Do not combine different baselines/builds/catalogs into a claimed controlled delta.

## External manifest

The manifest is development/offline data. Case/pair names, baseline hashes and acceptance evidence never enter runtime state, settings, sessions or telemetry. The reporter does not parse prompts, transcripts, prompt hashes or model prose.

Example shape (replace every placeholder with actual observations; this is **not runnable evidence**):

```json
{
  "schemaVersion": 1,
  "evidenceKind": "authenticated-local",
  "runs": [
    {
      "caseId": "implementation",
      "pairId": "implementation-high-replicate-1",
      "mode": "auto",
      "sessionId": "ACTUAL_AUTO_SESSION",
      "accepted": true,
      "acceptanceEvidence": "external verifier output + factual human review, recorded path/date",
      "telemetry": ["auto-export.json"],
      "configuration": {
        "providerId": "openai",
        "baseline": {
          "commit": "ACTUAL_REPOSITORY_COMMIT",
          "fixtureSha256": "PREPARE_OUTPUT",
          "workspaceSha256": "PREPARE_OUTPUT",
          "protocolSha256": "HASH_OF_DIRTY_PROTOCOL_REVISION"
        },
        "environment": {"node":"ACTUAL_VERSION","vscode":"ACTUAL_VERSION","platform":"ACTUAL_PLATFORM"},
        "extension": {"version":"0.1.0","sha256":"ACTUAL_VSIX_HASH"},
        "catalog": ["ACTUAL_ROUTER", "ACTUAL_LOW", "ACTUAL_MEDIUM", "ACTUAL_HIGH"],
        "autoMapping": {"Router":"ACTUAL_ROUTER","LOW":"ACTUAL_LOW","MEDIUM":"ACTUAL_MEDIUM","HIGH":"ACTUAL_HIGH"},
        "control": {"modelId":"ACTUAL_HIGH"},
        "premiumModels": ["ACTUAL_HIGH"],
        "toolPolicy": {"timeoutSeconds":30,"maxReadChars":65536,"maxSearchResults":30}
      }
    }
  ]
}
```

Add the Manual run with its distinct `sessionId`, `mode:"manual"`, acceptance result and `manual-export.json`; copy **exactly** the same `configuration` and `caseId`/`pairId`. The reporter refuses an unpaired manifest. Repeat per case. `accepted` is the operator's declaration backed by external verification; the reporter cannot attest files or test results from telemetry alone. Do not mark it true until the verifier passes and any required human review is complete.

Paths resolve relative to the manifest. Each export must contain only its explicitly mapped session. Duplicate requests, turns, reused sessions, orphan records, mismatched provider/mode/model/accounting or paired configurations are rejected. Actual models must be in the captured catalog, Auto requests must match configured role/tier IDs, and every Manual request must use the explicit control/effort. The reporter reads production records and ignores precomputed export summaries.

## Metrics and quality gate

JSON/Markdown show case, mode, acceptance, actual model IDs, initial/final routes, outcome, total model requests, Router requests, configured premium requests, escalations, tool/verification calls, rejected tools, duration, Router retry count and observed token coverage. Repair count is `null`: no independent repair metric exists. Durations are summed turn wall time, not summed overlapping request/tool time or human end-to-end stopwatch time. Tool counts include control calls/cache results as recorded, not guaranteed physical filesystem calls.

Both accepted arms are compared separately from all attempted runs. The transparent resource rule compares total requests **and** configured premium-request count: componentwise lower/same/higher gives Correct + fewer/same/more resources. Opposing changes give Correct + mixed resources. Any failed arm gives Failed / incomplete. Duration is reported separately. This rule is not a cost/quality score, and a cheap failed run is never a win. Cross-case aggregate totals must not conceal failed cases or heterogeneous controls.

Current exports contain optional `observed_*_tokens` from `LanguageModelChat.countTokens`, not provider-reported exact usage. OpenAI currently supplies no count through that interface. The reporter labels these observed values, shows coverage and returns `null` for an incomplete total; it never invents exact counts. No pricing configuration or monetary calculation is implemented in this minimal tool. ChatGPT subscription usage is not API billing. Future API-equivalent estimates require explicit verified pricing **and** suitable usage provenance, with an estimate label; this protocol makes no such claim.

## Tool verification

```bash
npm run test:benchmark
NX_BENCHMARK_SYNTHETIC_OUTPUT=.test-results/ui08 node scripts/test-benchmark-report.cjs
```

Six reporter tests cover honest aggregates/unknown tokens, quality gates/zero-request failures, disproof/mixed counts, observed coverage and invalid/duplicate metadata. Six workspace tests prove each baseline fails and known deterministic solutions pass, while protected test edits fail. Generated synthetic reports are prominently `synthetic-tooling-only`, with real results PENDING. Benchmark tooling, fixtures, outputs, tests and evidence are excluded from the production VSIX.
