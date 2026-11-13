# paj-rc implementation plan

## Current status

The initial implementation is present: Pi adapter, separate chat IPC, authenticated browser UI,
systemd setup/idle lifecycle, and accompanying Paj admission hooks. The README describes source
installation and known limitations. Nothing is installed or exposed by building or testing it.

Local checks cover HTTP/authentication, IPC, adapter behavior, lifecycle, and a real Chromium run
at phone-screen size. The generated unit passed systemd verification, and an isolated Pi process
loaded both source extensions. Real interactive user-service and phone/Tailscale deployment remain
to be validated with user approval. Pi's void input-dispatch interface remains an explicit
fail-closed limitation; see the README before deploying.

## Goal

Build a mobile-friendly browser interface for existing, live main Pi sessions. Distribute it as a
separate Pi package requiring Paj. Support Linux distributions with systemd user services, without
requiring Nix or NixOS. Keep paj.nvim unchanged.

The browser controls the actual running Pi session; it must not start a second Pi runtime against
the same session file. Voice input/output and orchestration are outside this project.

## Agreed user experience

- Install the Pi package and complete an explicit, one-time setup.
- Starting the first eligible main Pi session automatically starts the background user service.
- Additional main sessions register automatically and appear in the browser across projects.
- Select a main agent to read its conversation, send instructions, and observe live progress.
- Subagents never appear, start the service, or keep it alive.
- Closing a session removes it. After the last eligible session exits, stop the service following
  a short configurable grace period, initially 30 seconds.
- Reloading extensions or replacing a session must not unnecessarily restart the service.
- Browser disconnection or phone suspension must not cancel agent work.
- Serve on loopback by default. The core application does not require Tailscale.
- Recommend Tailscale Serve in the README as a private HTTPS remote-access option. Never silently
  install Tailscale, change its configuration, or enable public Funnel access.

Proposed Pi commands are `/rc setup`, `/rc status`, and `/rc settings`. Confirm exact command and
package names during implementation; no published package currently exists.

## Architecture

```text
Phone or desktop browser
          |
Optional secure reverse proxy, such as Tailscale Serve
          |
Loopback HTTP server in the paj-rc systemd user service
          |
Private, versioned local IPC
          |
paj-rc extension in each eligible main Pi process
          |
Public Pi extension APIs plus a small Paj integration contract
```

The service owns HTTP, bundled browser assets, authentication, and connection routing. Each Pi
extension owns session history projection, streaming state, input submission, and local policy
checks. No development server or Nix tooling should be required by an installed package.

Use a separate remote-chat transport. Do not repurpose Paj's existing editor bridge or its
agent-to-agent inbox. The remote browser represents the human user, not another agent.

### Main-session eligibility

Require all of the following before exposing or controlling a session:

- Paj is active and reports a live registration matching the process and current Pi session.
- The role is `primary`, with no parent identity or Paj child/spawn metadata.
- Pi is in interactive TUI mode; `hasUI` alone is insufficient because RPC also provides UI.
- The paj-rc endpoint is healthy and uses a compatible protocol version.

Never fall back to children when no main sessions exist. Enforce eligibility on history, streaming,
submission, and stop routes, not only in the agent picker. Omit sessions without a working addon.
Use stable Pi session IDs plus endpoint generations for routing, not names or PIDs alone.

### Service lifecycle

- Setup installs a distribution-independent systemd user unit and private configuration.
- The extension requests an idempotent service start only for an eligible main session.
- Use bounded startup/reconnect retries and verify the expected service protocol.
- On service restart, existing eligible extensions reconnect and restore registrations.
- Session replacement invalidates the old endpoint generation and acquires a fresh Pi context.
- Determine membership using live connections and liveness checks, not a fragile increment/decrement
  counter. Missing goodbye messages must not leave the service running forever.
- Idle shutdown rechecks eligibility before exiting. A registration racing shutdown must either
  prevent exit or reconnect and restart the service without losing the Pi session.
- Configure crash recovery independently from successful idle termination. Intentional shutdown
  must stay stopped; service failure must not terminate Pi or its ongoing work.
- Do not enable the service permanently at login by default. Tailscale's lifecycle is independent.
- A stopped service means the browser URL is unavailable until the next eligible Pi session starts.

Use systemd for ownership and supervision rather than electing a web-server owner among Pi
processes. Exact restart limits, connection leases, executable paths, and environment propagation
must be validated on ordinary Linux user-service installations.

## Paj integration

Paj already provides discovery, names, projects, roles, parent identity, heartbeats, and lifecycle
recovery. Reuse these rather than introducing a competing registry of agent identities.

A small, versioned in-process contract is recommended for production:

- Registration readiness, identity snapshots, and registration changes/removal.
- Editor bridge ownership and lifecycle notifications.
- Shared admission/reservation for external turns so editor and browser requests cannot race.

A CLI-based discovery prototype can work without Paj changes, but registry status polling alone
cannot safely arbitrate competing editor/chat submissions. Keep any necessary Paj modifications
small, backward compatible, and independently tested. Preserve the paj.nvim protocol unchanged.

Paj's existing bridge rejects busy requests, applies read-only policies to most requests, requires
proposal finalization, and cancels owned work on client disconnect. Those semantics must not leak
into ordinary browser chat. Reject browser input while an editor request owns the session rather
than contaminating its review, proposals, or tool policy.

## Initial feature scope

- Main-agent list across projects, with names, project/branch context, and availability/activity.
- Current-branch conversation history, with bounded pagination.
- Live user/assistant messages and concise tool activity, including terminal-originated turns.
- Plain-text user-message submission to the selected live session.
- Explicit busy behavior: validate steering and follow-up support before exposing those choices;
  never silently choose how to interleave a new request.
- Explicit stop control bound to the current session generation and run.
- Reconnection, resynchronization, and clear unavailable/error states.
- A terminal-interaction-required indication for blocking dialogs where Pi exposes that state.

Initially exclude arbitrary terminal dialogs, built-in slash-command parity, archived-session
launching, session/model management, file uploads, voice, and agent delegation. Ordinary chat
must preserve permission hooks and must not bypass approvals when the browser cannot answer them.

### Input and streaming correctness

- Use `pi.sendUserMessage`, not terminal keystrokes or Paj agent messages.
- Browser text is literal initially; do not enable arbitrary command/template expansion implicitly.
- The inspected extension API returns `void` from `sendUserMessage`. Distinguish submission from
  confirmed appearance in history and from completion. Test transformed/handled/rejected input.
- Assign request IDs and deduplicate at the target session. Do not blindly replay a write after
  a lost response; report uncertain delivery honestly.
- Subscribe before snapshot assembly, sequence events, and resnapshot after gaps or invalidation.
- Reconcile deltas with completed messages. Bound buffers and keep slow clients off Pi's event path.
- Use `agent_settled` as a final notification, not a continuation boundary.
- Preserve active-stream state in the target extension so service restart can resynchronize.
- Filter history on the server: no hidden messages, system prompts, thinking, or unbounded tool/file
  payloads by default. Main transcripts can still contain visible reports from their children.

## Security and configuration

- Bind HTTP only to loopback by default, with an explicitly configured port and allowed origins.
- Protect local IPC directories and sockets with owner-only permissions.
- Provide application authentication suitable for localhost and generic secure reverse proxies.
  Do not make Tailscale headers the only authentication mechanism.
- Persist private authentication material across daemon restarts; support revocation/rotation.
- Validate Host and Origin, protect writes against CSRF, reject wildcard CORS, and sanitize
  Markdown.
- Apply body limits, rate limits, deadlines, bounded streaming, and strict target validation.
- Never accept arbitrary filesystem paths or socket destinations from the browser.
- Avoid tokens in URLs and logs. Clearly document the same-user local-process trust boundary.
- Keep HTTP localhost development and remote HTTPS cookie/security requirements explicit.
- Configure user-service executable paths deliberately; do not assume an interactive shell's PATH.

The README should guide Tailscale installation/login on the computer and phone, private HTTPS
Serve setup, access restrictions, verification, and troubleshooting. Check existing Serve/Funnel
configuration before suggesting changes. Never use a global Serve reset for application cleanup.
Document other secure reverse proxies as possible, but do not encourage unauthenticated public
exposure. Tailscale is networking infrastructure, not the application's session authority.

## Implementation sequence

1. Establish package layout, supported Pi/Paj versions, runtime configuration, and test commands.
2. Prove the session adapter with two main sessions and one child. Validate public Pi history,
   input, streaming, stop, and editor-admission behavior before investing in the browser UI.
3. Add the minimal Paj integration contract if required by that proof; preserve editor behavior.
4. Implement authenticated local IPC, daemon discovery, routing, and systemd lifecycle management.
5. Implement authenticated HTTP and a minimal browser client, then refine the mobile experience.
6. Add setup/status/settings commands, package installation support, and README guidance.
7. Exercise end-to-end behavior locally and over Tailscale before claiming remote support works.

Build in testable slices. Treat network controls as authority to run code with Pi's permissions,
not as a transcript-only viewer. Do not silently weaken the security model to simplify a demo.

## Acceptance checks

- Concurrent main-session startup produces one service and the correct main-only list.
- A child never starts, appears in, or prolongs the service, even if it inherits the addon.
- Browser prompts and terminal prompts share the intended session without overwriting drafts.
- Browser disconnect, service restart, and phone suspension do not cancel agent work.
- Prompt retries cannot duplicate tasks; stale session/run IDs cannot control replacement sessions.
- Reload, new/resume/fork, branch changes, compaction, retries, and registry recovery resynchronize.
- Editor reviews/finalization and accepted actions cannot race with incompatible browser input.
- Last-main exit stops the service after the grace period; rapid restart cancels or recovers from
  idle shutdown. Main-process crashes and stale endpoints eventually clean up.
- Unauthenticated, cross-origin, oversized, forged-target, and stale-control requests fail closed.
- Installation and user-service startup work without Nix or reliance on shell startup files.
- Real phone testing confirms private HTTPS streaming/reconnection and verifies no Funnel exposure.

## Research basis and remaining validation

Research inspected Paj `6d11056`, paj.nvim `8a4cb23`, and installed Pi version `1.2.0`.
Recheck these interfaces against the actual implementation dependency versions before coding.

Useful local sources in the sibling Paj checkout:

- `../paj/src/registry.rs`: registration metadata, liveness, and private runtime storage.
- `../paj/extensions/paj/index.ts`: registration, lifecycle, editor ownership, and Pi events.
- `../paj/extensions/paj/bridge.ts`: editor request transport and disconnect behavior.
- `../paj/skills/paj-subagents/scripts/tmux-agent`: child role and parent/spawn metadata.
- `../paj.nvim/lua/paj/init.lua`: primary selection with a fallback that paj-rc must not copy.

Primary Pi and networking references:

- [Pi extensions](https://github.com/earendil-works/pi/blob/main/docs/extensions.md)
- [Pi extension APIs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [Pi session manager](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)

Existing Paj JavaScript tests passed: 160 tests. Rust tests could not run because rustup had no
configured default toolchain. No paj-rc runtime, systemd, or phone/Tailscale integration has yet
been tested. Generic remote dialog responses and fully acknowledged input delivery remain API
limitations to validate, not capabilities to promise.
