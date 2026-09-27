# Investigation and implementation choices

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
