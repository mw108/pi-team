# Executed validation

## Project-local team validation — 2026-09-28

| Check | Result |
| --- | --- |
| `npm run check` | Passed: TypeScript, Prettier, **94 automated tests** |
| `node --import tsx --test tests/project-local.test.ts` | 15 focused tests passed: Git-root resolution, config and prompt validation, init/migration, doctor, permissions, state and drift approval |
| `npm run doctor` | Passed outside the filesystem sandbox: all 13 project prompts and selected model IDs found, Pi/Serena/pi-ask/Context7 checks passed; legacy global config reported but not used |
| `node --import tsx scripts/project-local-smoke.ts` | Passed: temporary Git repo initialized, customized Solver prompt loaded by a real Pi SDK session, deterministic fixture workflow completed from a subdirectory with real tests and local commit, changed prompt paused resume |

The machine-readable [project-local fixture evidence](project-local-validation.json) records a `DONE` workflow commit and subsequent `configDrift` pause for `agents/solver-pragmatic.md`. The real Pi SDK session was created to verify the project prompt; workflow agents returned deterministic fixture results, so this run did **not** test remote model inference. The fixture commit occurred only in the temporary test repository. No Git push occurred.

The prior `~/.pi/agent/team.yaml` remains available for explicit `/team-init --from-global` migration, but normal `/team` no longer reads it. Old `.pi/team-state/` is diagnosed and preserved rather than merged into hashed project state. Doctor's first sandboxed attempt could not lock the existing Pi credential store; rerunning with normal filesystem access passed.

## Enhancement validation — 2026-09-28

| Check                                                                                         | Result                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check` (`npm run typecheck`, `npm run format:check`, `npm test`)                     | Passed: TypeScript, Prettier and **79 automated tests**                                                                                                                   |
| `node --import tsx --test tests/http.test.ts`                                                 | 16 focused loopback HTTP tests passed                                                                                                                                     |
| `node --import tsx --test tests/discovery.test.ts`                                            | Command discovery/selection/resume, real argv execution and timeout evidence passed                                                                                       |
| `node --import tsx --test tests/approval-hooks.test.ts`                                       | 6 focused dirty-file/hook tests passed                                                                                                                                    |
| `node --import tsx --test tests/ask-compatibility.test.ts`                                    | 5 compatibility/selection tests passed against installed pi-ask 1.2.0 and failure fixtures                                                                                |
| `node --import tsx --test tests/enhancements-e2e.test.ts`                                     | 2 tests passed: combined enhancement fixture and actual `/team doctor` handler                                                                                            |
| `npm run doctor`                                                                              | Passed: package/API checks, Serena tool registration/backend availability, Context7 configuration, local HTTP policy rejection, Git/hooks/dirty status and command counts |
| Normal `pi --offline --no-session` startup and interactive `/team doctor`                     | Passed; all integrations loaded, no extension errors; diagnostic output displayed in the TUI                                                                              |
| `pi --offline --no-session -e ./scripts/ask-approval-ui-smoke.ts`, then `/ask-approval-smoke` | Actual adapter opened pi-ask's multi-select TUI; both synthetic options were selected/submitted and returned correctly                                                    |

The combined fixture uses deterministic test-agent outputs and synthetic approval callbacks, with **real** repository edits, a configured loopback-only HTTP POST with JSON, Code Reviewer/Security Reviewer phases, `npm test` execution, and an intended-file-only local Git commit. No synthetic approval authorizes a real user repository operation. The new complete pipeline was not rerun with the remote language model; the older model-driven run below remains separate evidence.

HTTP tests exercise all seven methods, custom application headers, JSON/content-type precedence, malformed raw payloads, mutually exclusive body/json, GET/HEAD payload rejection, request/header byte and count limits, timeout, truncation, rejected methods/origins/schemes/credentials, local and external redirects, IPv6, localhost and legacy origin configuration. Command tests verify no execution before selection, rejected commands remaining unavailable, workflow-local persistence, malformed input handling, deduplication, literal shell metacharacters, and real stderr/timeout results. Hook fixtures demonstrate disabled defaults and enabled execution, with quality gates rejecting commit before hook invocation. Dirty-file fixtures preserve original content, pause/deny/approve exact paths, reject broad aliases, and require manual commit without staging any hunks. Existing routing/isolation/limits/path/hash/staged-change regressions still pass.

The synthetic TUI evidence is in [approval-ui-validation.json](approval-ui-validation.json). Doctor does not contact application pentest endpoints or probe live Context7 connectivity. No additional lint tool is configured; TypeScript is the project's static analysis check.

## Original environment validation — 2026-09-27

Completed on 2026-09-27.

| Check                                                                                    | Result                                                                                                           |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pi --version`                                                                           | 0.87.1                                                                                                           |
| Normal `pi --offline --no-session` TUI startup with all five local package registrations | Passed; no extension load errors; one MCP server enabled                                                         |
| `pi list`                                                                                | Pi Team and all four integrations registered                                                                     |
| `npm run check`                                                                          | Passed: TypeScript, Prettier, **37 automated tests**                                                             |
| `npm run doctor`                                                                         | Passed: all 13 role models registered/authenticated; supplied remote endpoint reachable                          |
| `npm run smoke`                                                                          | Passed: real Serena symbol lookup, Context7 resolution plus documentation retrieval, real web-search source URLs |
| Synthetic pi-ask TUI form                                                                | Opened and normalized a synthetic answer through the documented event bridge                                     |
| Live `/team` command via Pi SDK against remote Qwen model                                | Completed with optional pentest/security gates enabled, real tests and an intended-file-only local commit        |

The live fixture reached `DONE` after an explicit guarded resume. The first Tester attempt claimed success without executing a command; the guard rejected it. The final runner executes configured validation deterministically and supplies captured evidence to the Tester. In the successful continuation, the actual Node test command exited **0**, Code Reviewer returned **APPROVED**, and Security Reviewer returned no unresolved findings. The workflow retained its original failure counter and budget.

The committed file was **math.js only**, with commit `a6b6e80291ad1a50629eb2ae38e735c58d39e0ea` in the temporary fixture repository recorded in [live-validation.json](live-validation.json). No Git push occurred. This is a test-repository commit, not a commit of the Pi Team checkout.

The automated tests deliberately exercise local/design/requirements routing, both security repair routes, full/local/pentest/failure limits, corruption, serialization, interruption/resume, explicit failed-solver resume with preserved siblings, schema correction and persistent malformed output, independent concurrent solvers, permission boundaries, real test failure blocking commit, preserved baseline changes, pre-existing staged files, changed-file hash protection and rejection of fabricated test success.

Independent machine-readable evidence is in [integration-validation.json](integration-validation.json), [ask-validation.json](ask-validation.json) and [live-validation.json](live-validation.json).

## Practical limits

- OpenAI/Codex authentication and inference were not configured or tested; Pi supports those providers for later role selection.
- The live security gates inspected a small pure-function fixture. Broader exploitation against an application was not tested.
- Serena 1.7.0 lacks the upstream onboarding-check method advertised by Pi Serena; team sessions exclude that optional method. Symbol navigation was tested successfully.
- The current model demonstrated malformed and semantically incorrect role outputs during development. Validated schemas, bounded retries, phase-specific prompts, execution evidence and deterministic routing contain these failures; arbitrary future tasks can still stop for review.
- Commands must be reviewed for each target repository, either through exact workflow-local discovery approval or explicit configuration. Discovery is conservative and does not cover every build system or complex CI fragment. Script executables and third-party extensions run with host permissions; the permission controls are not an OS sandbox.
- Interrupted mutating operations require inspection before replay. The engine never automatically infers an interrupted commit's success or resets exhausted budgets.

- Git hooks remain disabled by default. Explicitly enabled hooks execute arbitrary trusted repository code; their side effects are not sandboxed.
- Approved dirty contract files require manual diff inspection/staging/commit. No automatic hunk attribution is attempted.
- pi-ask has no documented public host-call API in 1.2.0; the adapter still uses its isolated, probed internal registration API and rejects unverified minor versions.
