# Pi Team

A Pi-native development team with isolated role sessions, configurable parallel independent solvers, validated JSON results, deterministic TypeScript routing and resumable repository-local state. Models reason about the work; the engine controls its lifecycle.

## Installed environment

This setup uses Pi **0.99.2**, `@eko24ive/pi-ask` **1.2.0**, `@bacnh85/pi-serena` **0.9.18**, `pi-mcp-adapter` **3.0.0**, `pi-web-access` **0.32.0**, and the existing Serena **1.7.0**. Node 24+ is required. Exact dependency versions are in `package-lock.json`.

The user-facing `pi` executable is installed under `~/.local/bin`. This project and its four integration packages are registered as local Pi packages. Keep this checkout and its `node_modules` directory available.

See [investigation](docs/investigation.md), [executed validation](docs/validation.md), [progress fixture evidence](docs/progress-validation.json), [project-local fixture evidence](docs/project-local-validation.json), [integration validation](docs/integration-validation.json) and [live workflow validation](docs/live-validation.json) for checks actually performed. The prior live workflow completed after a guarded resume; its original failure budget was preserved.

## Start a task

Open Pi anywhere inside the target Git repository. Pi Team resolves its Git root for configuration, prompts, state and Git operations:

```bash
cd /path/to/repository
pi
```

Then enter:

```text
/team-init
/team Implement feature X according to requirement Y.
/team doctor
/team-status
/team-report
/team-report <workflow-id>
/team-log
/team-log researcher
/team-log researcher --attempt 1
/team-steer solver1 Stop repeating failed reads and finalize.
/team-abort solver1
/team-retry solver1
/team-stop
/team resume
/team resume <workflow-id>
```

Run `/team-init` once in each repository, then set real provider/model IDs in `.pi/team/team.yaml`. `/team-init --repair` adds a missing Reporter prompt and config entry to an existing project team. `/team-stop` interrupts agents and preserves state. `/team resume` opens the most recent state; specifying an ID selects an older workflow. Runtime guardrail and presentation changes are accepted and logged; semantic changes to completed agents or workflow behavior pause resume for explicit pi-ask review. A never-run agent may use a new prompt or model on its first attempt. Changing `solverCount` before SOLVE starts is accepted as a future-phase change; once SOLVE starts, it is blocking semantic drift. Edits to inactive Solver prompts do not affect the current workflow. Before implementation, approval restarts reasoning with the new definition and the original limits. After implementation, semantic drift blocks for manual inspection. Old states without a semantic snapshot conservatively block when team YAML changes. Semantic drift during REPORT uses the deterministic report fallback.

### Completion reports

The successful route ends with Commit Agent → Reporter → DONE. The host builds a compact `CompletionReportInput` from the final workflow state. Changed paths come from the created commit or final Git working tree compared with the starting dirty paths; validation commands come from the Tester's recorded execution results; reviews, gate settings, commit details, warnings and open issues come from their final structured state. Solver proposals are not treated as implemented work. The Reporter has no tools or web access, uses a low temperature, and returns structured JSON. The host keeps factual fields authoritative, persists the final report in workflow state, and renders it in the terminal. `/team-log` remains available for detailed diagnostics.

```text
Team DONE

Summary
Authentication error handling was corrected.

Implemented
- Login errors are displayed to the user.

Changed files
- src/login.ts

Validation
- ✓ Code review: passed
- ✓ npm test: passed
- ⚠ Pentest: disabled

Commit
abc1234 Fix login error handling
```

`/team-report` displays the latest completed workflow; `/team-report <workflow-id>` selects a saved workflow. Both reuse persisted results without a model call. Older DONE states without a Reporter result get a deterministic fallback from available state. When an older state has no recorded commit, its changed paths are marked unavailable rather than inferred from today's working tree. While a workflow runs, `/team-report` shows its current phase. `/team-status` marks completed reports as available. If Reporter output is malformed, times out, fails at the provider, or is aborted, completed implementation and validation stay DONE and the host renders a factual fallback. `/team resume` replays an interrupted REPORT without rerunning implementation, tests or commit. `/team-retry reporter` starts a fresh report attempt and preserves the previous report unless replacement succeeds.

BLOCKED output identifies the stopped phase and agent, the recorded reason, completed agents, repository mutation state, available diagnostics, and a deterministic next action when one is safe. For example:

```text
Team BLOCKED

Stopped at
RESEARCH · researcher

Reason
Agent execution failed: provider terminated

Completed
✓ orchestrator

Repository changes
No implementation recorded.

Diagnostics
- Agent failures: 1/2

Next action
/team-retry researcher
```

The in-place progress widget shows each agent as `○` pending, `●` running, `✓` completed with a current valid result, `✗` failed, or `↺` when a previous result was invalidated and a rerun is required; `◉` marks a pause for user input. Parallel Solvers update independently. Running agents show elapsed time, refreshed every two seconds by default, and a short activity label such as “Serena: references,” “Context7,” “Running tests,” or “Creating commit.” Tool arguments, source text, credentials and private reasoning are never included. Completed phases remain visible without adding permanent log lines. `/team-status` shows the same live information while this Pi session is running; after a restart it reports persisted state and says live timing is unavailable. `/team-stop` immediately marks running agents stopped and clears the heartbeat.

Researcher `unresolvedQuestions` are blocking user decisions. Pi Ask presents every question in one interaction and persists each answer with its question. Each Researcher result with one or more unresolved questions opens one clarification round, regardless of the number of questions. The Researcher runs again to incorporate the answers; Solvers start only after the current result has no unresolved questions. A canceled dialog remains pending for `/team resume`. `workflow.maxQuestions` limits ordinary questions and approvals; `workflow.maxResearchClarifications` independently limits Researcher clarification dialogs (default 5, `0` means unlimited). The widget shows the clarification count while waiting.

Configuration drift treats `maxLocalFixCycles`, `maxPentestCycles`, `maxAgentFailures`, `maxResearchClarifications`, `maxToolCalls`, `agentTimeoutMs`, `requestTimeoutMs`, `networkRetry`, and `doomLoop` as runtime settings. Agent `timeoutMs`, `requestTimeoutMs`, `maxToolCalls`, `networkRetry`, `doomLoop`, and `temperature` are also runtime settings. `maxFullCycles` and `maxQuestions` remain semantic because they bound design restarts and user decisions. A blocked workflow can use `/team-continue` after a raised runtime limit when its limit blocker is no longer active and repository safety checks pass.

A **run** is one fresh agent execution. Review, pentest, and security remediation create normal new Implementor runs without consuming the agent failure or technical retry budget. A **technical retry** is a fresh run after execution failure or `/team-retry`; the UI labels it separately from the run number. A **network retry** reconnects within the same run and AgentSession. Persisted history retains the `attempt` field as the run sequence for older states and logs; new start events also include `retryNumber` and a trigger.

```yaml
workflow:
  maxQuestions: 5
  maxResearchClarifications: 5
```

### Runtime controls

| Command                            | Behavior                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/team-steer <agent-id> <message>` | Queue guidance in the same Pi session and run. Delivery waits until Pi finishes the current tool calls. The existing timeout keeps running.                                                                                          |
| `/team-abort <agent-id>`           | Stop only that run, without a replacement or failure-budget charge. Other agents continue.                                                                                                                                           |
| `/team-retry <agent-id>`           | Stop the current run if needed, dispose its session, and start a fresh technical retry run with the same phase input. The request does not use the automatic retry or failure budget. A genuine failure in the new run still counts. |
| `/team-continue`                   | Continue a BLOCKED workflow at the next safe incomplete phase after checking prerequisites, configuration and repository state. It takes no agent or phase argument.                                                                 |
| `/team-stop`                       | Stop the entire workflow.                                                                                                                                                                                                            |

Use instance IDs such as `solver1`, `solver2`, `researcher`, and `codeReviewer`. `/team-status` shows current runs and these commands. A manual retry starts a new wall-clock timeout and cancels any reconnect wait in the old run. An aborted Solver can be skipped when the configured quorum remains satisfied; otherwise the workflow blocks with the proposal count. A manually aborted non-Solver blocks until you retry that agent. `/team-retry` can recover a workflow blocked by the target agent without starting a new workflow.

### Runtime recovery

`/team-continue` advances a BLOCKED workflow only when the next agent has never started and all earlier phases completed. For example, `✓ Implementor`, `○ Code Reviewer`, `BLOCKED` continues with Code Reviewer run 1. A failed Implementor instead needs `/team-retry implementor` after inspecting its repository effects. `✓ Commit Agent`, `○ Reporter`, `BLOCKED` can continue at Reporter. A workflow in `WAITING_USER` needs its pending answer or approval. `/team-status` and the BLOCKED report show the same next safe action.

`/team-retry <agent-id>` reruns a specific agent with an existing attempt or result. `/team resume` restores or replays persisted interrupted work after Pi restarts, following its existing read-only replay rules. `/team-continue` moves from a safely recoverable BLOCKED transition to the next incomplete phase without rerunning completed work.

## Doom-loop detection

Pi Team detects repeated tool calls from normalized tool names and arguments. `read(A)` four times, or `A → B → A → B → A → B`, triggers the detector at the default thresholds. Successful and failed calls count the same. Read ranges, search patterns, symbol names, and resource identities stay in the signature, so reads of successive file ranges do not look identical. Signatures remain in memory; attempt logs record only safe tool names and detector events.

The first two detections steer the current agent to change approach. A further loop disables tools and asks for a final structured result. If finalization still produces invalid output, the attempt fails with `AgentDoomLoopError`. Pi's `AgentSession.steer()` injects the control message as a user-role message. Pi Team intentionally uses this path for Qwen compatibility; the message role cannot be configured. `/team-steer` clears the current pattern history without using an automatic intervention, `/team-abort` clears queued steering through session cancellation, and `/team-retry` starts a fresh detector with the new session. Network reconnects leave the detector intact.

`workflow.maxToolCalls: 0` means unlimited tool calls; a positive integer is a hard budget. On the first call beyond a positive budget, Pi Team blocks that call, disables tools, and steers the agent to finalize with existing information. It queues this steering only once. `agents.<id>.maxToolCalls` can override the workflow budget, including with `0`. Doom-Loop detection remains independent and active with unlimited tool calls. `/team-status`, the live widget, and `/team-log` show detector interventions and finalization state.

```yaml
workflow:
  maxToolCalls: 0 # unlimited
```

```yaml
workflow:
  doomLoop:
    enabled: true
    windowSize: 12
    maxIdenticalCalls: 4
    maxRepeatedPattern: 3
    maxInterventions: 2
    # steerPrompt: "Stop repeating tool calls and finalize."
agents:
  researcher:
    doomLoop:
      maxIdenticalCalls: 6
      # steerPrompt: "Use the evidence collected and finish the research result."
    # maxToolCalls: 150
```

Each agent override inherits omitted fields from `workflow.doomLoop`. The window accepts 4–100 calls. The identical threshold and repeated-pattern threshold are at least 2; interventions are 1–10. `maxInterventions: 0` is invalid, so automatic steering cannot continue without a bound. The optional prompt changes only the steering text.

For a repeated failing tool call, try `/team-steer solver1 Stop repeating failed reads and finalize.` If it remains stuck, use `/team-retry solver1` for a fresh conversation. Use `/team-abort solver1` when no replacement is wanted.

Retrying a completed result asks for confirmation. The old result remains available while the replacement runs and remains in place if the replacement fails. A successful upstream retry invalidates dependent reasoning: Researcher invalidates Solvers onward; one Solver invalidates Critic onward; Critic invalidates Reviewer onward; Reviewer invalidates implementation and gates; Implementor invalidates review and validation gates. If a later read-only phase is running, its active agent is stopped before the upstream retry and downstream reasoning is recomputed. When implementation has already changed the repository, an upstream reasoning retry is refused so existing changes are preserved. A completed Implementor retry requires confirmation and starts on the current working tree without resetting files. Retry requests during a mutating downstream phase are refused; stop the workflow and inspect the repository before retrying.

“Design cycle” counts full research/design attempts; “Local fixes” counts implementation repairs. The Pentest cycle and Pen Tester/Security Reviewer appear only when pentesting is enabled. Disabled quality gates are identified explicitly. Project teams can tune the widget in `.pi/team/team.yaml`:

```yaml
ui:
  progress:
    enabled: true
    refreshMs: 2000 # 500–10000
    showToolActivity: true
    showModels: false # optional concise model IDs
```

A clean Git status means there are no uncommitted changes. Existing changes are recorded and preserved. A contract that touches a path already dirty at task start waits for explicit per-file approval before implementation. Denied files remain blocked. Approved dirty files require manual commit inspection; automatic staging cannot establish hunk ownership. Unrelated pre-existing dirty files are excluded from commits. Existing staged changes prevent automatic commit.

## Install from scratch

```bash
npm install -g --prefix "$HOME/.local" @earendil-works/pi-coding-agent@0.99.0
export PATH="$HOME/.local/bin:$PATH"
cd /path/to/pi-team
npm ci --ignore-scripts
pi install /absolute/path/to/pi-team
pi install /absolute/path/to/pi-team/node_modules/@eko24ive/pi-ask
pi install /absolute/path/to/pi-team/node_modules/@bacnh85/pi-serena
pi install /absolute/path/to/pi-team/node_modules/pi-mcp-adapter
pi install /absolute/path/to/pi-team/node_modules/pi-web-access
```

Pi host-provided extension packages are declared as `peerDependencies` with `"*"` so Pi supplies them at runtime. Pinned versions in `devDependencies` support local typechecking and tests.

These local registrations reuse the locked, inspected copies. The integrations also support their documented npm installation form:

```bash
pi install npm:@eko24ive/pi-ask@1.2.0
pi install npm:@bacnh85/pi-serena@0.9.18
pi install npm:pi-mcp-adapter@3.0.0
pi install npm:pi-web-access@0.32.0
```

Choose one registration per package; registering both the local and npm copies creates duplicate resources. Run `/reload` or restart Pi after registration changes. `pi list` shows active package sources. Pi now uses the `@earendil-works` package scope; this extension is written against the installed 0.87.1 declarations, not an older SDK.

## Team configuration

Pi Team is installed once as a global Pi extension. Its engine, commands and bootstrap templates are global; each repository owns its active definition. The configuration search order is:

1. The file named by `PI_TEAM_CONFIG`, when explicitly set (relative paths resolve from the Git root).
2. `<repo>/.pi/team/team.yaml`.
3. An actionable initialization error.

Normal `/team` execution never reads `~/.pi/agent/team.yaml` or bundled template prompts. Initialize from the [complete template](templates/team.yaml):

```text
/team-init
# Existing .pi/team/: reports existing files, changes nothing
/team-init --repair
# Adds missing template files only; preserves all existing files
/team-init --from-global
# Copies compatible settings from the old global team.yaml and creates project prompts
```

The generated tree contains `.pi/team/team.yaml`, `.pi/team/agents/*.md`, `.pi/team/.gitignore` with `state/`, and `.pi/team/state/`. Initialization never commits files or edits the repository root `.gitignore`. Commit the YAML, prompts and nested `.gitignore` when they represent your team's reviewed policy; keep state private. If the directory already exists, default init does not change it. `--repair` creates only missing files. `--from-global` reads the legacy global config only when requested, transfers compatible settings into a new project YAML, preserves the old file and never overwrites an existing project YAML or prompt.

Every active workflow slot has a configured logical `role`, `prompt`, `provider`, `model` and `thinking`. The agent key is its stable internal ID; optional `name` is only its user-facing label, and `role` defines logical behavior. Older configs without `name` keep the established display label. Commands such as `/team-retry solver1` still use the ID, regardless of the display name. Changing a name does not rename its prompt file. The prompt path is relative to `.pi/team/`. The default three independent Solver instances can share a model or use different providers and prompts:

```yaml
agents:
  solver1:
    name: Architecture Expert
    role: solver
    prompt: agents/solver-architecture.md
    provider: local
    model: your-model-id
    temperature: 0.2
    thinking: off
  solver2:
    name: Solver Pragmatic
    role: solver
    prompt: agents/solver-pragmatic.md
    provider: local
    model: your-model-id
    temperature: 0.5
    thinking: off
  solver3:
    name: Solver Alternative
    role: solver
    prompt: agents/solver-alternative.md
    provider: local
    model: your-model-id
    temperature: 0.8
    thinking: off
```

Set `workflow.solverCount` to an integer from 1 to 10 (default 3). The active IDs are contiguous `solver1` through `solverN`. Each needs its own explicit `agents.solverN` entry with `role: solver`; extra configured Solvers remain inactive. To add `solver4` through `solver10`, add each agent entry and a prompt file under `.pi/team/agents/`, then set its `prompt:` path (for example, `agents/solver-performance.md`). The entries may use distinct prompts, models, providers, and temperatures. Quorum is 1 of 1, both of 2, and at least half rounded up for 3–10:

| Configured | Required successful |
| ---------: | ------------------: |
|          1 |                   1 |
|          2 |                   2 |
|          3 |                   2 |
|          4 |                   2 |
|          5 |                   3 |
|          6 |                   3 |
|          7 |                   4 |
|          8 |                   4 |
|          9 |                   5 |
|         10 |                   5 |

The default solver prompts favor architecture, minimal change and alternative approaches respectively, while retaining the same output contract. For a Laravel project, add its conventions to `agents/implementor.md`; for Angular, tailor `agents/reviewer.md` to component and testing patterns. A security-heavy Solver can use a separate prompt file with its own `prompt:` path, and a minimal-change Solver can favor existing patterns in `agents/solver-pragmatic.md`. Keep the required slot names and logical roles; optional pentest may be disabled, but its slot remains defined for schema consistency. Set every placeholder `model: configure-model-id` to a model Pi can resolve, or use `--from-global` to carry over known-working assignments.

### Agent sampling

Each agent can set `temperature: 0.2` alongside `thinking: off`. Temperature is optional and must be a finite number from 0 to 2. When omitted, Pi and the provider use their model default; existing project configurations do not need an edit. Lower values favor consistency, while higher values allow more varied samples. The template uses 0.2 for the architecture Solver, 0.5 for the pragmatic Solver, and 0.8 for the alternative Solver. Their distinct prompts remain the main source of different approaches; temperature does not guarantee better reasoning.

Pi 0.87.1 has no temperature argument on `createAgentSession()` or `session.prompt()`. Pi Team passes the configured value through that agent session's `ModelRuntime.streamSimple()` generation options on each request. Pi's OpenAI-compatible adapter sends it as the `temperature` request field. An explicit agent value overrides a model's `samplingParams.temperature`; an omitted value leaves the provider/model default untouched. Workflow state saves the resolved agent configuration, and the existing team YAML hash catches temperature edits during resume. `/team doctor` reports invalid values and statically known unsupported combinations.

Provider support varies. Pi Team rejects explicit temperature for Pi APIs whose installed adapter does not forward it, Anthropic extended thinking or models marked as not supporting temperature, and OpenAI/Codex reasoning models. For other supported adapters, a model or server may still reject a particular value; that provider error is reported rather than treated as a successful application. Check the chosen model before using the template examples with a different provider.

Project YAML and Markdown are repository-controlled input. Prompt paths must stay within `.pi/team/`, including through symlinks; missing, empty or unreadable prompts fail early. A prompt cannot grant tools or change the engine's centrally enforced role permissions. YAML cannot import modules, run shell text or bypass command approval, Git protections or local HTTP policy. Pi's normal repository instructions remain available to sessions alongside each project's role prompt.

Commands are explicit executable/argument lists, not shell strings:

```yaml
commands:
  - id: test
    executable: npm
    args: [test]
    purpose: test
    timeoutMs: 120000
  - id: typecheck
    executable: npm
    args: [run, typecheck]
    purpose: static
    timeoutMs: 120000
```

The host discovers candidate argv commands from bounded repository reads: package/Composer scripts, PHPUnit config, Cargo/Go manifests, pytest settings in `pyproject.toml`, Make/just targets, Taskfile tasks and recognized simple README/CONTRIBUTING/CI command lines. Malformed data and shell chains are ignored. Discovery is conservative rather than exhaustive: custom Gradle/Maven/Nx/Angular conventions and complex CI shell fragments need explicit configuration. Candidates retain source, purpose and confidence and are deduplicated by exact executable/arguments. Commands run at the repository root.

**Discovered → user-approved → workflow-local → deterministically executed.** Before research continues, the Orchestrator presents pi-ask's multi-select form, for example:

```text
Approve repository validation commands
[ ] ["npm", "test"]              package.json scripts.test; test
[ ] ["npm", "run", "typecheck"]  package.json scripts.typecheck; typecheck
[ ] ["npm", "run", "lint"]       package.json scripts.lint; lint
[ ] ["npm", "run", "build"]      package.json scripts.build; build
```

Select all or a subset and submit; select none to reject all. No option is automatically approved. Cancellation/noninteractive execution persists `WAITING_USER`; `/team resume` reopens the same request. Freeform text and notes cannot grant permissions. Discovery offers likely commands for pre-approval; it is not an exhaustive command list. `approvedCommands` and discovered source evidence are persisted only in this workflow's state, never automatically written to project configuration. Already configured argv commands count as preapproved. Configure them in repository `.pi/team/team.yaml` to avoid repeated prompts. Rejecting all candidates when no preapproved validation exists blocks a workflow with testing enabled.

Agents with command permission may also call `team_command` with a structured `{ executable, args, purpose, category? }` request. The host validates it with the same command schema as discovery, assigns the deterministic `detected-*` ID, and asks through pi-ask before execution. The choices are **Allow once** (one execution, no persisted grant), **Allow for workflow** (exact executable and argv persisted in `approvedCommands`), **Allow similar** (only when a displayed, conservative test-command prefix is available), and **Deny** (a structured tool result, not an agent failure). A similarity rule stores `{ executable, argsPrefix, allowRemainingArgs: true, category }`; no executable wildcard or fuzzy matching is used. Pending requests carry workflow, agent, run, and request IDs and appear in `/team-status`. Parallel prompts are queued. After a restart, `/team resume` re-presents a saved request; the old agent session and its command are never replayed automatically. An interrupted mutating phase still requires the usual inspection and retry. Command details in prompts, JSONL, live activity, and `/team-log` use redacted argv; execution receives the original argv.

Deterministic Tester control executes every approved `test`/`static` command once, supplies captured stdout, stderr, exit codes and timeout evidence to the model, and overrides fabricated results. No successful checks means no PASS. The existing `purpose` values remain backward compatible: Implementor gets `development`, `test` and `static`; Code Reviewer gets `static`; Tester gets `test` and `static`; Pen Tester gets `pentest`. Rich discovery categories such as lint/build/typecheck map to `static`. Processes use `shell: false`, fixed argv and a small environment without provider credentials. Raw shells, Git executables and control/chaining tokens are rejected. An approved package script may itself run arbitrary local code, including shell commands; inspect its source before approval. These are permission controls, not an OS sandbox.

## llama.cpp and compatible endpoints

The configured remote base URL is exactly:

```text
https://overload-speak-sleek.ngrok-free.dev
```

The discovered model `unsloth/Qwen3-Coder-35B-A3B:Q8_K_XL` is registered as Pi provider `local` in the private `~/.pi/agent/models.json`. Roles select their own provider/model IDs in `.pi/team/team.yaml`. The server reported a 262,144-token context window. The extension caps output at 8,192 tokens.

The base URL remains unchanged. Pi's OpenAI-compatible client adds the protocol's `chat/completions` request path itself. Do not append `/v1` to this configured base. For a different endpoint, use the exact base it requires, which may include `/v1`.

Before a custom OpenAI-compatible request, Pi Team probes the provider's Router management root with `GET /models`. Pi's built-in OpenAI providers are skipped. Only a nonempty `data` array of entries with `id` and Router `status.value` enables the preflight. A configured root URL stays at the root; a final `/v1` is removed with URL parsing; other path prefixes are left to the existing provider path. The exact selected model ID must be present. `loaded` proceeds immediately; `unloaded` sends `POST /models/load` once and waits; `loading`, `downloading`, and the brief `downloaded` transition are polled every 1.5 seconds until ready. An unloaded entry with `status.failed` fails with its `exit_code`. A missing ID fails without downloading or substituting a model. `sleeping` is already routable in llama.cpp: its child wakes automatically on inference, and `/models/load` only starts unloaded instances. This follows both the installed Pi 0.99 llama.cpp client and the Router implementation. The current configured server reports build `b10233-0ab9d6fed` through `/props`.

Readiness runs inside the `streamSimple()` wrapper before `provider_request_start`, provider request numbering, and Pi's existing inference timeout. The agent's wall-clock timeout and abort signal cover the wait. Concurrent callers for the same provider, Router URL, and model share one load operation and one temporary SSE listener; different model IDs remain independent. Unsupported OpenAI-compatible endpoints retain the normal provider path. The live TUI shows `checking model`, `loading model`, or a Router-supplied percentage while waiting; provider and tool activity replace it after readiness. After `GET /models` confirms Router capability and finds a model that is not ready, Pi Team listens to `/models/sse` for progress while continuing `/models` polling as the readiness authority. The SSE listener closes on readiness, failure, or final waiter abort. A missing or disconnected SSE feed leaves polling functional and clears its last progress value.

The Router sends plain `data: {"model":"...","event":"model_status","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":0.45}}}` SSE frames, without a separate SSE `event:` name. A new SSE client receives future broadcasts rather than a replayed state; the initial `/models` response supplies the starting snapshot. The model field must exactly match the requested ID. `value` is a 0–1 fraction of the current stage; Pi Team combines it with the ordered stage list into one 0–1 progress value for the existing TUI. Non-finite values are ignored and finite out-of-range values are clamped. Progress JSONL events are emitted at the first value and then only after changes of at least five percentage points; model status logs remain transition-based.

For a local OpenAI-compatible server, adapt [models.example.json](config/models.example.json) under the Pi agent directory, replacing the example ID with one actually served by your endpoint. A dummy `apiKey` makes an unauthenticated local endpoint selectable. Use environment interpolation for real credentials.

Pi also provides a native llama.cpp router integration. For a local router:

```bash
llama-server --models-dir /path/to/gguf-models --no-models-autoload \
  --jinja --host 127.0.0.1 --port 8080 -ngl 999 -c 32768
```

Then use `/login llama.cpp`, `/llama` and `/model` in Pi. The native router integration normalizes the root URL and uses `/v1` for inference; use the custom provider when an endpoint needs the unchanged base used in this installation. The team runner resolves roles from Pi's model runtime and user `models.json`; custom OpenAI-compatible providers work without OpenAI credentials.

## Optional OpenAI/Codex roles

Use Pi's `/login` and `/model` to authenticate and inspect actual model IDs, or set the provider's documented environment variable such as `OPENAI_API_KEY`. Then set a role to `provider: openai` or `provider: openai-codex` and the real model ID. Do not copy example model names blindly. No OpenAI/Codex login was created by this setup.

## Integrations

### Questions through pi-ask

Only the Orchestrator presents user questions. Subagents return a validated `QUESTION_REQUEST`. The engine combines related questions, persists `WAITING_USER` before asking, invokes pi-ask's own `ask_user` implementation and resumes only after a nonempty submitted clarification. Use the built-in **Type your own** option or attach a substantive note; selecting the placeholder alone is not an answer. Cancellation and noninteractive mode leave the workflow waiting.

No custom question UI is implemented. `/ask-settings`, `/answer` and `/ask:replay` remain available through the installed package. `ask_user` requires Pi TUI mode for its rich form. Replay answers do not independently modify team state; `/team resume` reopens the persisted team question.

### pi-ask compatibility

Tested with **1.2.0**; the adapter currently accepts `>=1.2.0 <1.3.0` and also verifies the required file, export and actual `ask_user` registration. The package exposes its Pi extension entry point, but no documented public host-call API. The isolated adapter in `src/integrations/pi-ask.ts` therefore captures `registerAskTool` from `src/ask-tool.ts`; no other production workflow module imports pi-ask internals. Its own UI, selection contract and result normalization remain in use.

Pi session startup, `/team doctor` and `npm run doctor` check availability/version/registration and give an actionable error before workflow use. Review a new minor version's API, update the range intentionally, and rerun compatibility plus TUI tests before upgrading. The range is a compatibility policy, not a guarantee about untested patch releases.

### Serena

The existing Serena installation is reused. Fresh installs can use:

```bash
uv tool install -p 3.13 serena-agent
serena init
```

Pi Serena finds the uv-managed Python environment automatically, or accepts `SERENA_PYTHON`. It exposes persistent-worker-backed `serena_*` tools directly to Pi; Serena is not routed through MCP here.

Semantic navigation prefers symbol overview, symbol lookup, references, declarations and implementations. Raw search/read remains available for exact text, configuration, documents and narrow code regions. Strict Serena blocking is not enabled because it can interfere with normal repository exploration. The optional onboarding-check tool is withheld from team sessions because the installed Serena 1.7.0 does not provide that upstream method; semantic tools were tested successfully. Language support depends on Serena's LSP/backend and project requirements.

Implementor receives contract-scoped semantic edit tools. Cross-file rename and safe-delete are withheld because they can affect files outside the approved contract; use explicit scoped edits. File deletion uses `team_delete`, which requires an explicit `filesToDelete` entry. `.serena/` cache files are locally excluded from Git.

### Context7

`~/.pi/agent/mcp-adapter.json` contains a `context7` entry using `https://mcp.context7.com/mcp`. The setup reuses the existing private credential without changing its original configuration. Credentials are never stored in this repository.

For environment authentication:

```bash
export CONTEXT7_API_KEY='your-key'
```

See [mcp.example.json](config/mcp.example.json). The runner uses an isolated `createMcpAdapter` configuration with only `resolve-library-id` and `query-docs`, rather than importing unrelated MCP servers. Researcher, Solvers, Reviewer, Implementor, Code Reviewer and Security Reviewer receive documentation access. Critic, Tester and Commit Agent do not. Query documentation only when external API/version/library behavior matters. The Researcher retains material external source references in state.

### Web research

`pi-web-access` provides `web_search` and `fetch_content` to the Researcher. The setup uses the existing `EXA_API_KEY` environment variable and an Exa provider configuration in `~/.pi/agent/web-search.json`; no search engine is implemented. Ensure Pi inherits the credential from its launching shell. Curator UI is disabled for unattended Researcher sessions. Other roles do not receive web tools by default.

Activity labels describe capabilities: `web_search` is “Web search” whether Exa or another supported provider supplies it; `fetch_content` is “Web research.” The installed MCP adapter exposes a generic `mcp` tool with a nested tool name. Only known Context7 calls render as “Context7”; unknown MCP calls render as “MCP tool.” No separate `pi-exa` extension is installed in this setup. Project-specific tools can be classified in `.pi/team/team.yaml`, for example:

```yaml
toolActivity:
  mappings:
    "custom_search_*": { category: web-search, provider: Custom }
    "context7_*": { category: documentation, provider: Context7 }
ui:
  progress:
    showToolProvider: false
```

Exact mappings take precedence over prefix patterns. Provider names are shown only when `showToolProvider: true`; mapping values are validated and tool arguments are never displayed.

## Workflow and routing

```mermaid
flowchart TD
  O[Orchestrator] --> R[Researcher]
  R --> S1[Solver 1]
  R --> S2[Solver 2]
  R --> S3[Solver 3]
  S1 --> C[Critic]
  S2 --> C
  S3 --> C
  C --> V[Reviewer: Implementation Contract]
  V --> I[Implementor]
  I --> CR[Code Reviewer]
  CR -- FIX_LOCAL --> I
  CR -- FIX_DESIGN --> R
  CR -- FIX_REQUIREMENTS --> Q[Orchestrator + pi-ask]
  Q --> O
  CR -- APPROVED --> P{Pentest enabled?}
  P -- yes --> PT[Pen Tester]
  PT --> SR[Security Reviewer]
  SR -- FIX_LOCAL --> I
  SR -- FIX_DESIGN --> R
  SR -- validated --> T[Tester]
  P -- no --> T
  T -- FAIL --> I
  T -- PASS --> G[Commit Agent + deterministic commit]
  G --> D[Done]
```

Testing failures classified as `FIX_DESIGN` return to Researcher. Every fix invalidates later quality approvals. Files are hashed at quality gates and checked again before commit; changes after review block the commit. Tester edits, when enabled, require another reviewed cycle rather than bypassing an earlier review.

### Test responsibility

The Reviewer specifies automated coverage in the Implementation Contract. Each `requiredTests` entry has a `description`, an `action`, and optional `file`, `scope` (`unit`, `integration`, `e2e`, or `other`) and `acceptanceCriteria`. `existing` means current coverage must keep passing; its file may be omitted if unknown. `modify` means the Implementor updates the named existing test file, which must be in `filesToModify`. `create` means the Implementor adds the named new test file, which must be in `filesToCreate`. Contract validation rejects mismatched lists and conflicting create/modify actions for the same path. Test paths receive the same repository boundary checks as other contract paths.

The Implementor writes the required production and test code before Code Review. The Code Reviewer checks the actual diff and test assertions against the contract and returns `FIX_LOCAL` for ordinary missing coverage. The Tester then executes approved validation commands. `tester.mayModifyTests` remains `false` by default; enabling it is an exceptional repair capability, not the normal owner of contract tests.

For example, a login contract can keep its success test and require a new failure case in the same file:

```json
{
  "filesToModify": [
    "src/app/login/login.component.ts",
    "src/app/login/login.component.spec.ts"
  ],
  "filesToCreate": [],
  "requiredTests": [
    {
      "description": "Successful login remains covered",
      "action": "existing",
      "file": "src/app/login/login.component.spec.ts",
      "scope": "unit"
    },
    {
      "description": "Failed login displays the backend error",
      "action": "modify",
      "file": "src/app/login/login.component.spec.ts",
      "scope": "unit",
      "acceptanceCriteria": [
        "HTTP error is returned",
        "backend message is displayed",
        "submitting state resets"
      ]
    }
  ]
}
```

Penetration testing is off by default. Enable only authorized, disposable local application targets:

```yaml
qualityGates:
  pentest: { enabled: true }
pentest:
  localHttp:
    allowedOrigins: [http://127.0.0.1:8000, "http://[::1]:8000"]
    allowedMethods: [GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS]
    timeoutMs: 10000
    maxRequestBodyBytes: 1048576
    maxResponseBodyBytes: 2097152
tester:
  mayModifyTests: false
  testPaths: [tests/, test/]
```

Defaults authorize no origins and GET only. Legacy `pentest.localUrls` still approves each URL's loopback origin; new `allowedOrigins` entries must be origin-only HTTP(S) URLs. Both are checked. Only `127.0.0.1`, exact `localhost`, and IPv6 `[::1]` are permitted, with exact scheme/host/port origin matching. The direct Node transport ignores proxy environment variables; localhost DNS results must all be loopback and are pinned to the connection. Credentials in URLs, other schemes, fragments and all redirect responses are rejected. IPv6 and localhost origins are independent approvals. Doctor validates configuration without sending pentest requests.

Example `team_local_http` input:

```json
{
  "method": "POST",
  "url": "http://127.0.0.1:8000/api/profile",
  "headers": {
    "Authorization": "Bearer disposable-test-token",
    "X-CSRF-Token": "test-token"
  },
  "json": { "displayName": "<script>alert(1)</script>" },
  "timeoutMs": 5000
}
```

`method` defaults to GET for old callers. `body` is raw text (including form data/malformed JSON); `json` is serialized once, including JSON null. Supplying both is an error; GET/HEAD reject either. JSON supplies `Content-Type: application/json` only when absent; an explicitly supplied content type wins. At most 32 headers and 8 KiB of header name/value bytes are accepted. Application Authorization, Cookie, Accept, CSRF and content-type headers are allowed; Host, proxy, forwarding-host and HTTP framing/hop-by-hop headers are rejected. Environment credentials are never injected and requests have no cookie jar or credential forwarding. Request limits count UTF-8 bytes. The whole request/response has a bounded timeout; per-call timeout can shorten but never extend it. Responses return `status`, `statusText`, `headers`, `body`, `truncated` and `durationMs`, capped by raw response-body bytes. Compressed/binary bodies are not decompressed; text decoding may replace an incomplete final UTF-8 character. No infinite streaming is permitted.

The Pen Tester uses reversible probes against disposable local test data. Broader controlled execution requires an explicitly approved `pentest` command; public/third-party targets are outside this workflow. Security Reviewer validates each finding and requires repair for confirmed findings; accepted risks still require human review.

## State, limits and recovery

State is authoritative structured JSON under `.pi/team/state/<workflow-id>.json`. Atomic writes flush a temporary file before rename. State contains the task, requirements, configuration snapshot, config and prompt hashes, baseline Git evidence, results, findings, questions/answers, counters, history, commit intent, discovered/approved commands, exact dirty-path approvals and pending selections. Version 1 states migrate to version 2 on load: legacy string `requiredTests` entries become `{ "description": "...", "action": "existing" }` without invented file paths. Version 1 states missing the earlier additive fields load conservatively, but workflows without project config and prompt hashes cannot resume automatically. Existing `.pi/team-state/` files are preserved and reported as legacy; start a new workflow after project initialization. Full agent conversations and private reasoning are not forwarded between roles. Read-only role sessions are fresh and in memory; phase-specific structured results form their context.

`/team-init` creates `.pi/team/.gitignore` containing `state/`; an equivalent root `.gitignore` entry is `.pi/team/state/`. The engine adds a local `.git/info/exclude` entry only for Serena caches. It preserves project ignore files and leaves team YAML/prompts available for version control. State can contain repository source/diffs, so treat it as private. Directory/file permissions are 0700/0600 for newly created state. It is not an encrypted secret store.

Defaults are three full design cycles, five local repairs, two pentest runs, two agent failures, five submitted questions, 80 tool calls per invocation and a five-minute fallback agent timeout. The template suggests longer budgets for local models. An omitted `agents.<role>.timeoutMs` inherits `workflow.agentTimeoutMs`; a positive value sets that agent's wall-clock timeout in milliseconds (1,000–3,600,000 ms); exactly `0` disables the wall-clock timeout. `workflow.agentTimeoutMs: 0` disables the default wall-clock timeout for agents with no override. The budget covers the agent's commands and model exchange after session setup, not inactivity. `/team doctor` displays disabled timeouts as `unlimited`. The resolved config snapshot retains the configured `0`, while attempt logs record `timeoutMs: null` and `timeoutMode: unlimited`.

`workflow.requestTimeoutMs` sets each provider request timeout in milliseconds (default 300000). `agents.<role>.requestTimeoutMs` overrides it for one agent. Both accept non-negative integers; `0` uses Pi 0.99's disabled-timeout mapping. This setting is independent of the whole-agent `agentTimeoutMs`, Pi's HTTP idle timeout, and network retries. Provider request start and failure logs record the effective value and whether it came from the agent, workflow, or default; failed-attempt logs also show it. Changes take effect on fresh requests after config drift is accepted.

```yaml
workflow:
  agentTimeoutMs: 600000
agents:
  researcher:
    timeoutMs: 0 # no wall-clock timeout
  solver1:
    timeoutMs: 900000
```

Unlimited time can help slow local models, large repositories, long-running tool-heavy research, and implementation agents. It does not disable `maxToolCalls`, `maxAgentFailures`, `maxQuestions`, `maxFullCycles`, `maxLocalFixCycles`, `maxPentestCycles`, schema validation, tool permissions, command approval, Git safeguards, quality gates, provider failure handling, or manual cancellation. Keep prompts focused, preserve loop protection, and use `/team-abort` for one agent or `/team-stop` for the workflow when needed. Tester validation commands retain their separate `commands[].timeoutMs` budgets. Existing project YAML is never rewritten. Counters persist through resume; failed Solver proposals in a SOLVE phase that met quorum remain recorded but do not consume the global failure budget. A read-only agent wall-clock timeout may trigger one hard retry; `retry 1/1` means the second and final attempt, and the widget shows the prior failure reason. Every attempt start/failure and retry is persisted in workflow history. Malformed JSON gets one output-only correction with all tools disabled. Persistent malformed output is an invocation failure. Mutating roles do not automatically replay after failures.

### Network reconnects vs agent retries

A network reconnect reissues the current model request inside the same Pi agent session and agent attempt. Earlier conversation and tool results remain in that session. A broken token stream cannot resume at the exact token: Pi Team discards partial events from that request and sends the same request again. A hard agent retry creates a new attempt; it remains available for a read-only agent wall-clock timeout, subject to the existing failure budget. Connectivity failures, HTTP 502/503/504 and HTTP 429 do not consume that hard retry budget. Exhausted reconnects surface as a normal invocation failure.

```yaml
workflow:
  agentTimeoutMs: 0
  networkRetry:
    maxRetries: 10
    delayMs: 3000
agents:
  researcher:
    timeoutMs: 0
    networkRetry:
      maxRetries: 0
      delayMs: 3000
  solver1:
    timeoutMs: 0
  solver2:
    timeoutMs: 0
  solver3:
    timeoutMs: 0
```

Each agent inherits `maxRetries` and `delayMs` independently from `workflow.networkRetry` (defaults: 10 retries, 3000 ms). `networkRetry.maxRetries: 0` means unlimited reconnects; `timeoutMs: 0` independently disables the agent wall-clock timeout. `delayMs` must be an integer from 100 to 60000 ms; zero is invalid. `/team-stop` interrupts reconnect waits. Existing project-local `.pi/team/team.yaml` files are not rewritten; add these keys manually to opt in to overrides. `/team doctor` shows effective values.

Pi Team owns transport and HTTP 502/503/504 request retries at `ModelRuntime.streamSimple()`, with fixed delay. It also owns HTTP 429 retries there and uses `Retry-After` when the provider uses the request's `fetch` hook; otherwise the configured delay applies. Pi's session retry is disabled for isolated agents, and provider request retries are set to zero to avoid multiplied loops. Hard agent retry remains in the workflow engine. Reconnect events appear in the active `/team-status`, the same attempt JSONL file, and `/team-log`; summary start/recovery/exhaustion events enter workflow history.

With `logging.agentLogs.level: summary` (the default), each attempt has an append-only JSONL file at `.pi/team/state/<workflow-id>.logs/<agent>/attempt-N.jsonl`. `/team-log` lists attempts, `/team-log researcher` shows all attempts in order, and `--attempt N` selects one. Steering, user abort, and manual retry have distinct events in the timeline and concise workflow history. `/team-status` shows a concise final provider error and points to the logs. Summary events contain lifecycle, safe tool names/categories, duration, success or failure, and the final visible assistant text available from Pi before session disposal, capped at 64 KiB with known credential patterns redacted. They never include reasoning blocks, tool arguments, tool results, request bodies, headers, or query strings. `logging.agentLogs.level: off` disables new attempt files; history still records retries. Treat logs as private because visible assistant output can contain repository data. Logs are retained after completion and tied to their state file: remove `<workflow-id>.json` and its matching `<workflow-id>.logs/` together during manual retention cleanup; Pi Team does not silently delete either.

Provider request diagnostics in each attempt file number individual model invocations from 1, including those made after a network reconnect. Start and end events record the request duration; failure events add time to first stream event, time since last stream activity, effective timeout values, current retry number, abort state, tool count, and Doom-Loop finalization state. An agent timeout measures the session's wall-clock guard; a provider request duration measures one model invocation. Pi 0.87.1 supplies `httpIdleTimeoutMs` (300,000 ms in the in-memory default settings) as the request timeout unless an explicit provider timeout overrides it. The request event records the effective `requestTimeoutMs` supplied to `ModelRuntime.streamSimple()`. The wrapper does not expose Undici headers or body timeout settings, so the log does not invent them.

For example, `/team-log researcher --attempt 1` may show:

```text
provider request 6 failed after 300.0s
  TypeError: terminated
  cause: SocketError: other side closed
  code: UND_ERR_SOCKET
```

The JSONL failure event stores an allowlisted error class/name/message/code/status and up to five cause levels, ten aggregate children, and fifteen sanitized stack lines. It does not serialize arbitrary error properties, credentials, request contents, tool arguments, or endpoint URLs. `terminated` alone remains `other`; it is not automatically treated as a retryable network error. `classification` and `matchedRule` show why the existing classifier chose its result. A separate `terminated_diagnostic` event makes these failures easy to find.

A repository lock prevents concurrent team engines. A stale lock is reclaimed only if its process no longer exists. Corrupted states fail closed and remain untouched.

Interrupted read-only phases can resume automatically. An explicit `/team resume` can retry a blocked read-only agent failure while the original failure budget remains available; completed solver proposals are reused. It can also retry a read-only Tester failure when the guard proved zero validation commands executed and test writes were disabled. Interrupted implementation, test commands, pentest commands or commit operations block because their side effects may already exist. Inspect the repository and stored commit intent before deciding what to do. `/team-continue` advances a BLOCKED workflow only after a completed phase when the next phase has never started and its prerequisites still hold. It does not infer the success of interrupted mutating work or replay it. Other blocked workflows require inspecting the blocker and repository before retrying an agent or starting a new task. No destructive Git reset/clean/restore is used.

## Permission boundaries

These controls constrain model-facing capabilities; they are **not an OS sandbox**. Pi extensions execute with the user's host permissions. Only reviewed integration factories are loaded into child sessions; arbitrary repository extensions, skills and unrelated MCP servers are excluded. Repository-local instruction files still apply.

Read-only roles have no source-edit tools or shell. Source writes, deletes and semantic mutations are bounded by repository paths, symlink checks and the implementation contract. Tester edits are off by default and limited to configured test directories when enabled. Commands use `spawn` with `shell: false` and fixed argv. Direct Git executables and raw shell wrappers are rejected in configuration; Git mutations belong to deterministic commit control. A configured script can itself perform arbitrary operations, so its code and executable must be reviewed. Local network limits apply to the built-in HTTP tool; they cannot isolate a separately approved executable.

Commit Agent has read-only Git inspection and produces a message/file plan. Host code checks quality gates, exact intended file lists, baseline attribution, staged changes, HEAD, file hashes and common credential patterns before staging and committing. Commit hooks are disabled by default. See the explicit trust option below; required validation should normally be approved commands. Secret scanning is heuristic, not comprehensive. Changes to the same originally clean file made concurrently by the user cannot be perfectly attributed; avoid concurrent editing during a task. Git push is never performed and no push/reset/clean/rebase/force command tool is exposed.

## Git hooks and dirty-file approvals

```yaml
commit:
  runHooks: false
```

The default uses `git -c core.hooksPath=/dev/null commit`. Set `runHooks: true` only for an explicitly trusted repository: its configured hooks execute arbitrary local code with host permissions and can alter source/index contents or run network operations. This is never enabled by discovery or an agent. Quality gates, hashes, baseline attribution and staged-change protection are checked before staging and again before commit invocation. Trusted hooks can have side effects during Git's own commit execution; the extension cannot sandbox or preapprove those effects.

Pre-existing dirty paths are blocked for editing until the Orchestrator obtains exact per-file pi-ask selection. No wildcard, directory or normalized alias grants permission. Approval is workflow-local (`approvedDirtyPaths`), preserves current content as the editing base, and never invokes reset/restore. Denial blocks a contract requiring that file. For approved dirty contract files, after all gates pass the Orchestrator requests manual diff inspection/staging and stops automatic commit: it cannot prove which hunks came from the user. Existing staged changes still prohibit automation. A clean-baseline task with unrelated user edits can still commit only its intended clean files.

## Validation and troubleshooting

```bash
cd /path/to/pi-team
npm run check
npm run doctor  # also available inside Pi as /team doctor
npm run smoke
node --import tsx scripts/project-local-smoke.ts
node --import tsx scripts/progress-smoke.ts
node --import tsx scripts/live.ts
```

`check` runs TypeScript checking and workflow tests covering routing, loop limits, state, corruption, resume, structured-output correction, solver concurrency/failure, permissions, project-local configuration, progress and real local commits in temporary repositories. `smoke` directly invokes Serena, Context7 and web tools and updates `docs/integration-validation.json`. `project-local-smoke.ts` initializes a temporary repository, loads a customized project prompt through the actual Pi session factory, runs a deterministic fixture workflow from a subdirectory and checks prompt-drift gating; it writes `docs/project-local-validation.json` and does not invoke remote inference. `progress-smoke.ts` runs delayed fixture agents through complete workflows with pentest both disabled and enabled; it writes `docs/progress-validation.json`. `live.ts` creates a temporary repository and invokes the actual `/team` command through Pi SDK, including enabled pentest/security gates; it writes `docs/live-validation.json`. It requires a working configured model and does not overwrite this project's code.

If the model is missing, inspect `/model`, `models.json` and the selected role's provider/model ID. The role IDs must match Pi's registry. If the ngrok endpoint changes, update the base URL and verify the model:

```bash
node --import tsx scripts/configure-endpoint.ts https://your-endpoint.example
```

That helper uses the installed Pi llama.cpp discovery client and registers only an already loaded model. It sets only placeholder model assignments; manually chosen role models are preserved. Inspect `models.json` after changing endpoints.

If Serena fails, check `serena --version`, `SERENA_PYTHON`, project languages and LSP availability; use `/serena-restart`. If Context7 fails, check authentication, `/mcp-adapter` and the two allowed tool names. If search fails, confirm that the launching process has `EXA_API_KEY`. If a question opens in print/RPC mode, resume in interactive Pi. If commands are unavailable, select safe discovered commands in the approval form or preconfigure reviewed repository argv entries for a new task. If the working tree changes after review, inspect and restart the appropriate review rather than committing stale approval.

## Update and uninstall

Review current package documentation, source and compatibility before changing versions. Update the dependency pins intentionally, run `npm install --ignore-scripts`, then `npm run check`, `npm run smoke` and the live fixture. Local Pi registrations point to this checkout and use the updated copies after `/reload` or restart. Keep the previous lockfile to reproduce older versions. Update the global CLI explicitly with `npm install -g --prefix "$HOME/.local" @earendil-works/pi-coding-agent@<reviewed-version>`.

To unregister this installation:

```bash
pi remove /absolute/path/to/pi-team
pi remove /absolute/path/to/pi-team/node_modules/@eko24ive/pi-ask
pi remove /absolute/path/to/pi-team/node_modules/@bacnh85/pi-serena
pi remove /absolute/path/to/pi-team/node_modules/pi-mcp-adapter
pi remove /absolute/path/to/pi-team/node_modules/pi-web-access
```

Preserve or archive workflow states before removing them. Remove only the configuration entries created for this setup; do not delete unrelated user Pi/Serena/provider configuration. Serena predated this installation and should remain installed. Removing Pi Team does not push changes or rewrite repository history.
