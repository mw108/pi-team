# Pi 1.4.0 compatibility audit

Audit date: 2026-10-26. The comparison baseline is Pi 1.1.0, the exact SDK family pinned by Pi-Team before this audit. Earlier 0.87.1 and 0.99.0 integrations remain visible in Git history, but they are not treated as the immediate migration baseline.

## Installed runtime and dependency model

- `pi --version` reports 1.4.0.
- `pi` resolves to the managed launcher at `C:\Users\mario\.pi\agent\bin\pi.ps1`. Its launcher reads `install/current-version` and starts the selected release, so the retained 1.1.0 rollback directory does not create PATH ambiguity.
- The selected release contains matching 1.4.0 copies of `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui`, `pi-codemode`, and `pi-mcp`.
- Pi-Team declares host packages as wildcard peers and pins 1.4.0 only as development dependencies. `npm ls --all` resolves one deduplicated 1.4.0 SDK family, including pi-ask, pi-serena, pi-mcp-adapter, and pi-web-access. No `@mariozechner/*` import remains.
- The verified host is Node 26.11.1 with npm 11.20.0. Bun is not installed and Pi-Team does not require it.

## API inventory

Pi-Team uses the public `ExtensionAPI`, `ExtensionContext`, command and tool definitions, `DefaultResourceLoader`, `SettingsManager`, `SessionManager`, `ModelRuntime`, `AgentSession`, `createAgentSession`, Pi AI message streams/types, and Pi TUI types. The parent extension registers session lifecycle handlers and ten commands. Child role sessions load optional extension paths, register guarded custom tools, observe message/tool events, and call `setActiveToolsByName([])` during bounded finalization. Provider instrumentation wraps `ModelRuntime.streamSimple` without replacing Pi's message or tool-result correlation.

Pi-Team does not register `before_agent_start` or `before_provider_headers`, call `sendMessage`/`sendUserMessage`, call summary-generation APIs, generate Pi settings/themes/models schemas, or directly schedule codemode workers. Agent attempts use new in-memory Pi sessions; persisted workflow recovery is owned by Pi-Team's state schema rather than Pi session resumption.

## Compatibility matrix

| Pi change                                                                                      | Pi-Team usage                                                                       | Impact                         | Required action and evidence                                                                                                |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1.2 `before_agent_start` is a `messageType` union and fires for idle custom `triggerTurn` runs | No Pi-Team handler or sender                                                        | Not directly affected          | A deterministic 1.4 session test covers both user and custom variants so a future handler cannot assume `prompt` exists.    |
| 1.2 session is busy while start handlers run                                                   | No start handler or send API use                                                    | Not affected                   | No source change. Existing cancellation and queued steering tests remain authoritative for Pi-Team's separate control path. |
| 1.2 theme/config schema validation                                                             | Pi-Team owns only its separate team YAML schema                                     | Not affected                   | No Pi user configuration or theme was read or changed.                                                                      |
| 1.2 thinking omitted from serialized summaries                                                 | Pi-Team does not parse Pi summaries                                                 | Compatible                     | No source change. Workflow evidence remains in Pi-Team state and attempt logs.                                              |
| 1.3/1.4 resumed-session active-tool fixes                                                      | Child sessions are normally fresh, but permission-sensitive tool loadouts matter    | Compatible, security-sensitive | Added a real 1.4 resume test proving a recorded allowed tool is restored and a disabled tool is not activated.              |
| 1.3 malformed final tool-call arguments now fail validation                                    | Custom tools rely on Pi schema validation plus host guards                          | Beneficial                     | Existing schema, tool-call, authorization, and textual-recovery tests verify fail-safe handling.                            |
| 1.3/1.4 codemode admission and cancellation fixes                                              | Pi-Team does not invoke codemode; parallel Solvers are separate in-process sessions | Not directly affected          | No timeout expansion or worker override added. Pi-Team's bounded agent/provider deadlines remain unchanged.                 |
| 1.4 provider attribution headers move to pi-ai identity                                        | No header hook or custom attribution dependency                                     | Not affected                   | No credential or provider configuration change.                                                                             |
| 1.4 summary functions ignore `reserveTokens`                                                   | No direct summary API use                                                           | Not affected                   | Pi-Team retains Pi's compaction defaults and keeps workflow instructions in its reconstructed role prompt/state.            |
| 1.4 truncated tool-call recovery drops paired orphan results                                   | Pi-Team detects `stopReason: "length"` and never textual-recovers truncated calls   | Compatible, beneficial         | Existing output-truncation, normalized-response, tool-call, schema-repair, and recovery suites run against 1.4.             |
| 1.4 extension loader aliases `@earendil-works/pi-ai/models`                                    | No subpath import                                                                   | Not affected                   | Real file-based loading of `index.ts` succeeds on the 1.4 loader.                                                           |
| 1.4 whitespace-only tool results and provider retry classifications                            | Pi-Team preserves Pi result objects and adds bounded retry diagnostics              | Compatible, beneficial         | Provider, retry, request-timeout, and tool-result tests remain enabled.                                                     |

## Implemented migration

The three direct development SDK pins and lockfile were upgraded from 1.1.0 to 1.4.0. Pi's internal 1.4 packages now resolve as one exact family, preventing mixed SDK instances. Runtime peer declarations remain wildcard host peers, which is required for managed extension loading. No production integration dependency, model, provider, credential, Pi setting, workflow state, or project team YAML changed.

`tests/pi-1.4-compatibility.test.ts` adds public-runtime checks for real entry-point loading and command discovery, the `before_agent_start` union, custom `triggerTurn` execution, and safe tool restoration. Dependency tests now fail if local development drifts away from the 1.4 API family. Current operational README references were updated from 1.1/0.99 to 1.4.

## Verification scope

The deterministic suite exercises extension registration; custom tools and schemas; provider streams and tool-call correlation; cancellation, request deadlines, reasoning-stall recovery, network retries, and output truncation; runtime command, file, contract-path, and credential approvals; workflow creation, all role transitions, parallel Solvers, `FIX_LOCAL`, retry/recovery, state persistence, drift handling, security gates, Tester evidence, and Commit Agent authorization. Synthetic repositories and isolated temporary directories are used. No production provider request or credential is needed.

The full workflow fixture uses every configured role, performs a local HTTP pentest against its own loopback fixture, executes real tests in a temporary repository, and verifies the intended commit boundary. Test Git history exists only inside disposable fixture repositories; the Pi-Team checkout is never committed or pushed.

Final results:

- `npm run check`: 792 tests, 787 passed, 5 skipped, 0 failed. The skips are four optional Serena CLI lifecycle cases because `serena` is absent from `PATH`, plus the Linux-only Bubblewrap network case on Windows.
- Focused Pi 1.4 dependency, loader, event, tool-restoration, retry, and doom-loop run: 70 passed, 0 failed.
- `npm ls ... --all`: one deduplicated Pi 1.4.0 family.
- `git diff --check`: passed.
- `/team` command discovery through the 1.4 file loader: all ten commands registered.
- `npm run doctor`: Pi 1.4.0 and pi-ask/web/adapter registration were detected, but the command exits nonzero because Serena is not installed and this checkout's user-selected local model is currently absent. The audit did not install Serena or change the selected models.

`npm audit --omit=dev` reports five advisories: three high and two moderate. The affected locked versions (`zod` 3.25.76, `undici` 6.29.0 and Pi's nested 8.10.2, `body-parser` 2.3.0, and `fast-uri` 3.1.8) are byte-for-byte the same dependency versions present before this migration; the Pi SDK update did not introduce them. The suggested direct fixes require a Zod major migration or a Pi downgrade, and therefore were not applied during a Pi 1.4 compatibility migration. Transitive fixes should be reviewed separately without splitting Pi's exact 1.4 internal package family.

Remaining gaps are environmental rather than API failures: no Bun-specific codemode test can run because Bun is absent; no production LLM call was made; interactive terminal rendering and provider attribution over a live third-party endpoint were not exercised. These are not Pi-Team code paths requiring a compatibility shim. Reload or restart Pi after deploying the updated checkout, run `/team doctor`, restore the configured local model and optional Serena CLI as needed, and begin with a disposable project before resuming valuable persisted workflows.
