# Pi Team

A Pi-native development team with isolated role sessions, three parallel independent solvers, validated JSON results, deterministic TypeScript routing and resumable repository-local state. Models reason about the work; the engine controls its lifecycle.

## Installed environment

This setup uses Pi **0.87.1**, `@eko24ive/pi-ask` **1.2.0**, `@bacnh85/pi-serena` **0.9.18**, `pi-mcp-adapter` **3.0.0**, `pi-web-access` **0.32.0**, and the existing Serena **1.7.0**. Node 24+ is required. Exact dependency versions are in `package-lock.json`.

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
/team-log
/team-log researcher
/team-log researcher --attempt 1
/team-stop
/team resume
/team resume <workflow-id>
```

Run `/team-init` once in each repository, then set real provider/model IDs in `.pi/team/team.yaml`. `/team-stop` interrupts agents and preserves state. `/team resume` opens the most recent state; specifying an ID selects an older workflow. A changed team YAML or agent prompt pauses resume for explicit pi-ask review. Before implementation, approval restarts reasoning with the new definition and the original limits. After implementation, the workflow blocks for manual inspection.

The in-place progress widget shows each agent as `○` pending, `●` running, `✓` completed, or `✗` failed; `◉` marks a pause for user input. Parallel Solvers update independently. Running agents show elapsed time, refreshed every two seconds by default, and a short activity label such as “Serena: references,” “Context7,” “Running tests,” or “Creating commit.” Tool arguments, source text, credentials and private reasoning are never included. Completed phases remain visible without adding permanent log lines. `/team-status` shows the same live information while this Pi session is running; after a restart it reports persisted state and says live timing is unavailable. `/team-stop` immediately marks running agents stopped and clears the heartbeat.

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
npm install -g --prefix "$HOME/.local" @earendil-works/pi-coding-agent@0.87.1
export PATH="$HOME/.local/bin:$PATH"
cd /path/to/pi-team
npm ci --ignore-scripts
pi install /absolute/path/to/pi-team
pi install /absolute/path/to/pi-team/node_modules/@eko24ive/pi-ask
pi install /absolute/path/to/pi-team/node_modules/@bacnh85/pi-serena
pi install /absolute/path/to/pi-team/node_modules/pi-mcp-adapter
pi install /absolute/path/to/pi-team/node_modules/pi-web-access
```

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

Every one of the 13 fixed workflow slots has a configured logical `role`, `prompt`, `provider`, `model` and `thinking`. The prompt path is relative to `.pi/team/`. The three independent Solver instances can share a model or use different providers and prompts:

```yaml
agents:
  solver1:
    role: solver
    prompt: agents/solver-architecture.md
    provider: local
    model: your-model-id
    thinking: off
  solver2:
    role: solver
    prompt: agents/solver-pragmatic.md
    provider: local
    model: your-model-id
    thinking: off
  solver3:
    role: solver
    prompt: agents/solver-alternative.md
    provider: local
    model: your-model-id
    thinking: off
```

The default solver prompts favor architecture, minimal change and alternative approaches respectively, while retaining the same output contract. For a Laravel project, add its conventions to `agents/implementor.md`; for Angular, tailor `agents/reviewer.md` to component and testing patterns. A security-heavy Solver can use a separate prompt file with its own `prompt:` path, and a minimal-change Solver can favor existing patterns in `agents/solver-pragmatic.md`. Keep the required slot names and logical roles; optional pentest may be disabled, but its slot remains defined for schema consistency. Set every placeholder `model: configure-model-id` to a model Pi can resolve, or use `--from-global` to carry over known-working assignments.

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

Select all or a subset and submit; select none to reject all. No option is automatically approved. Cancellation/noninteractive execution persists `WAITING_USER`; `/team resume` reopens the same request. Freeform text and notes cannot grant permissions. Additional custom commands are supported through reviewed configuration, not freeform approval text. `approvedCommands` and discovered source evidence are persisted only in this workflow's state, never automatically written to project configuration. Already configured argv commands count as preapproved. Configure them in repository `.pi/team/team.yaml` to avoid repeated prompts. Rejecting all candidates when no preapproved validation exists blocks a workflow with testing enabled.

Deterministic Tester control executes every approved `test`/`static` command once, supplies captured stdout, stderr, exit codes and timeout evidence to the model, and overrides fabricated results. No successful checks means no PASS. The existing `purpose` values remain backward compatible: Implementor gets `development`, `test` and `static`; Code Reviewer gets `static`; Tester gets `test` and `static`; Pen Tester gets `pentest`. Rich discovery categories such as lint/build/typecheck map to `static`. Processes use `shell: false`, fixed argv and a small environment without provider credentials. Raw shells, Git executables and control/chaining tokens are rejected. An approved package script may itself run arbitrary local code, including shell commands; inspect its source before approval. These are permission controls, not an OS sandbox.

## llama.cpp and compatible endpoints

The configured remote base URL is exactly:

```text
https://overload-speak-sleek.ngrok-free.dev
```

The discovered loaded model is `unsloth/Qwen3-Coder-35B-A3B:Q8_K_XL`. It is registered as Pi provider `local` in the private `~/.pi/agent/models.json` and assigned to all roles in this repository's `.pi/team/team.yaml`. The server reported a 262,144-token context window. The extension caps output at 8,192 tokens. No remote models were downloaded, loaded or unloaded.

The base URL remains unchanged. Pi's OpenAI-compatible client adds the protocol's `chat/completions` request path itself. Do not append `/v1` to this configured base. For a different endpoint, use the exact base it requires, which may include `/v1`.

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

State is authoritative structured JSON under `.pi/team/state/<workflow-id>.json`. Atomic writes flush a temporary file before rename. State contains the task, requirements, configuration snapshot, config and prompt hashes, baseline Git evidence, results, findings, questions/answers, counters, history, commit intent, discovered/approved commands, exact dirty-path approvals and pending selections. Version 1 states missing the earlier additive fields load conservatively, but workflows without project config and prompt hashes cannot resume automatically. Existing `.pi/team-state/` files are preserved and reported as legacy; start a new workflow after project initialization. Full agent conversations and private reasoning are not forwarded between roles. Read-only role sessions are fresh and in memory; phase-specific structured results form their context.

`/team-init` creates `.pi/team/.gitignore` containing `state/`; an equivalent root `.gitignore` entry is `.pi/team/state/`. The engine adds a local `.git/info/exclude` entry only for Serena caches. It preserves project ignore files and leaves team YAML/prompts available for version control. State can contain repository source/diffs, so treat it as private. Directory/file permissions are 0700/0600 for newly created state. It is not an encrypted secret store.

Defaults are three full design cycles, five local repairs, two pentest runs, two agent failures, five submitted questions, 80 tool calls per invocation and a five-minute fallback agent timeout. The template suggests longer budgets for local models. `agents.<role>.timeoutMs` overrides `workflow.agentTimeoutMs`; both accept 1,000–3,600,000 ms. This is one total execution budget for the agent's commands and model exchange after session setup, not an inactivity timer. Tester validation commands retain their separate `commands[].timeoutMs` budgets. Existing project YAML is never rewritten. Counters are global to the workflow and persist through resume. One likely transient read-only failure may retry once; `retry 1/1` means the second and final attempt, and the widget shows the prior failure reason. Every attempt start/failure and retry is persisted in workflow history. Malformed JSON gets one output-only correction with all tools disabled. Persistent malformed output is an invocation failure. Mutating roles do not automatically replay after failures.

With `logging.agentLogs.level: summary` (the default), each attempt has an append-only JSONL file at `.pi/team/state/<workflow-id>.logs/<agent>/attempt-N.jsonl`. `/team-log` lists attempts, `/team-log researcher` shows the latest timeline, and `--attempt N` selects an earlier one. `/team-status` shows the last failure and points to the logs. Summary events contain lifecycle, safe tool names/categories, duration, success or failure, and the final visible assistant text available from Pi before session disposal, capped at 64 KiB with known credential patterns redacted. They never include reasoning blocks, tool arguments, tool results, headers, queries or full provider errors. `logging.agentLogs.level: off` disables new attempt files; history still records retries. Treat logs as private because visible assistant output can contain repository data. Logs are retained after completion and tied to their state file: remove `<workflow-id>.json` and its matching `<workflow-id>.logs/` together during manual retention cleanup; Pi Team does not silently delete either.

A repository lock prevents concurrent team engines. A stale lock is reclaimed only if its process no longer exists. Corrupted states fail closed and remain untouched.

Interrupted read-only phases can resume automatically. An explicit `/team resume` can retry a blocked read-only agent failure while the original failure budget remains available; completed solver proposals are reused. It can also retry a read-only Tester failure when the guard proved zero validation commands executed and test writes were disabled. Interrupted implementation, test commands, pentest commands or commit operations block because their side effects may already exist. Inspect the repository and stored commit intent before deciding what to do. The initial version does not automatically reset failed budgets, infer the success of an interrupted commit, or replay mutating operations. To recover other blocked workflows, preserve the state, inspect the blocker and repository, then start a new task or deliberately edit the structured state/configuration after review. No destructive Git reset/clean/restore is used.

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
