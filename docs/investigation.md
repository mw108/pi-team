# Investigation and implementation choices

## Pi 0.99 provider streaming and live progress (2026-10-01)

Inspected the installed `@earendil-works/pi-ai@0.99.0` declarations in
`node_modules/@earendil-works/pi-ai/dist/types.d.ts` and the implementation in
`dist/api/openai-completions.js`, plus Pi Team's `configureNetworkRetry` wrapper.
The `AssistantMessageEvent` union emits `start`, `text_start`, `text_delta`,
`text_end`, `thinking_start`, `thinking_delta`, `thinking_end`,
`toolcall_start`, `toolcall_delta`, `toolcall_end`, `done`, and `error`.
Each nonterminal event has a shared mutable `partial: AssistantMessage`;
`done.message` and `error.error` are the settled messages. There is no
normalized per-token usage event or output-token delta. `Usage.output` and
optional `Usage.reasoning` are provider-reported values on the message, but
the initial partial has zero usage and a provider may supply exact counts only
near completion. Pi Team therefore shows no live token count or tokens per
second and does not infer them from text or chunk sizes.

`StreamOptions.onProviderStreamEvent(data, model)` observes parsed raw provider
events only for adapters that explicitly support it. The local
`openai-completions` adapter invokes it for every parsed chunk, including
usage-only chunks. It maps `choice.delta.content` to `text_delta`,
`choice.delta.tool_calls` to `toolcall_delta`, and the first nonempty of
`reasoning_content`, `reasoning`, or `reasoning_text` to `thinking_delta`.
For llama.cpp, separate `reasoning_content` therefore supports a safe
`reasoning` activity indicator. Literal `<think>` tags inside ordinary
`content` remain normal text and are not interpreted here. No raw reasoning
text is copied into progress events or JSONL logs.

Pi Team already wraps `ModelRuntime.streamSimple` to own network retries and
observe each `AssistantMessageEvent`. It recorded request start, first
normalized nonterminal event, last normalized activity, duration, provider,
model, and retry number, but emitted no intermediate event. The wrapper also
buffers the assistant stream until the attempt ends, so the session's normal
assistant output and tool callbacks cannot reveal liveness during a long
request. Live telemetry now updates a small per-request snapshot from Pi
events and supported raw-chunk callbacks. The existing two-second UI heartbeat
renders it without redrawing for each delta. One five-second timer per open
request emits `provider_progress` JSONL snapshots after the first interval;
short requests emit none. The event carries request identity, `elapsedMs`,
optional `lastActivityMs`, state, and normalized `streamEventCount`. It never
contains text or inferred token metrics. `provider_request_end` retains the
authoritative duration and time-to-first-event values. The existing timeout
and retry behavior is unchanged.

Progress is live only and scoped by workflow runtime, agent role, attempt, and
provider request number. It clears when the request ends, when a new attempt
starts, and when the agent stops. Existing tool activity takes display priority
over provider progress. The TUI marks a still-open request idle after 60 seconds
without a provider event; that status does not abort the request.

Inspected before changes on 2026-09-27:

- macOS Darwin 24.4.0 on arm64; zsh; Node 24.16.0; npm 11.13.0.
- Empty Git repository with no initial commit or pre-existing project files.
- Pi absent from PATH; no `~/.pi` directory, packages, settings or credentials to preserve.
- Serena 1.7.0 installed through uv, with existing `~/.serena` configuration. CLI help/version worked. Global configuration remains untouched.
- llama.cpp binary installed under `/Applications/llama`; standard local endpoints were initially unavailable.
- Existing Context7 remote configuration and private credential found under OpenCode configuration. Existing Exa environment credential found without printing its value. Original configuration was preserved.
- The user supplied the remote llama.cpp URL during implementation. Exact root URL returned the llama.cpp web interface; Pi's installed discovery client found the already loaded model. No server model state changed.

## Reviewed sources

All selected packages were downloaded with `npm pack --ignore-scripts` and their manifests, README and relevant source inspected before installation. The initial `@mariozechner/pi-coding-agent` lookup returned 0.73.1, while current packages require the renamed scope. The compatible current release is `@earendil-works/pi-coding-agent` 0.87.1.

- [Pi source and SDK](https://github.com/earendil-works/pi/tree/main/packages/coding-agent): installed SDK/resource-loader/session/extension/model-runtime declarations and examples were used as authoritative API contracts. The installed llama provider/client source was checked for exact URL and discovery behavior.
- [pi-ask](https://github.com/eko24ive/pi-ask): 1.2.0; own `registerAskTool` implementation, input/output contract, noninteractive behavior and remote-events contract inspected. Team invokes the existing implementation, with no custom UI. The internal helper is pinned and must be rechecked on updates.
- [Pi Serena](https://github.com/bacnh85/pi-extensions/tree/main/pi-serena): 0.9.18; persistent worker, Python discovery, read/edit tool surface and optional strict behavior inspected. Direct integration selected; no Serena MCP configuration added.
- [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter): 3.0.0; programmatic isolated factory config, headers/environment support, lazy tool proxy, filtering and lifecycle reviewed. Child adapters only expose Context7 documentation tools.
- [pi-web-access](https://github.com/nicobailon/pi-web-access): 0.32.0; Exa support, environment credentials, researcher tool surface and curator configuration reviewed. Existing package selected for search and fetching.
- [pi-subagents](https://github.com/nicobailon/pi-subagents): 0.73.0; fresh-context delegation event contract, parallel support, structured-output and capability-ceiling APIs inspected. Not installed: Pi's established SDK provides the isolated sessions, model selection and tool control required here, and avoids adding another workflow controller.

## Plan implemented

Build only the unique team control layer: state schemas, deterministic router, hard limits, atomic persistence, phase-specific context, role registry, Pi SDK runner, narrow tool permissions, existing integrations, progress display and guarded commit plan execution. Validate routing with deterministic test agents and real repository checks/commits, then validate each integration and the actual `/team` command against the supplied model.

Third-party extensions run inside the trusted host. Source inspection does not establish that dependencies are free of vulnerabilities. The runtime boundaries and their practical limitations are documented in README.
