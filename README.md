# paj-rc

Private, mobile-friendly browser control for **existing live main Pi sessions**, across projects.
Paj supplies session identity and admission; paj-rc adds a separate authenticated browser transport.
It does not launch another Pi runtime, expose subagents, or change paj.nvim's protocol.

This is an early source release; no npm package has been published. Real systemd, phone, and
Tailscale end-to-end validation is still required; do not treat the tests as a security audit.

## Requirements and compatibility

- Linux with a working **systemd user manager** (`systemctl --user`). No Nix/NixOS requirement.
- Node.js **22.19 or newer**, plus Pi 1.2.x and Paj installed for the same user.
- The matching small, versioned Paj external-session integration seam in the sibling `../paj`
  checkout (`paj:external:v1` and its change notifications). An older published Paj without this
  seam is not compatible: discovery alone cannot safely exclude editor-owned work.
- A live interactive TUI main session registered by Paj. RPC sessions, children, and sessions
  without compatible integration are intentionally unavailable.

There are no npm runtime dependencies. The service uses absolute Node, Paj, and package paths; it
must not depend on your interactive shell startup files. Keep those paths installed and stable.
After moving the source checkout or upgrading an executable into a different path, rerun setup.

## Install with Nix

The flake provides `packages.x86_64-linux.default` and `packages.aarch64-linux.default`, like Paj.
The package includes the `paj-rc` command, Node.js runtime, browser assets, and extension sources.
Its sandboxed build runs the tests without installing services or changing user configuration.

For a local checkout:

```sh
nix profile install path:/absolute/path/to/paj-rc
paj-rc --help
```

As with Paj, installing the CLI and loading its Pi extension are separate. To follow Paj's
Home Manager pattern, add a flake input and use it for both the package and extension:

```nix
# Flake inputs
paj-rc = {
  url = "path:/absolute/path/to/paj-rc";
  inputs.nixpkgs.follows = "nixpkgs";
};

# Home Manager configuration, alongside the existing Paj package and extension
home.packages = [inputs.paj-rc.packages.${pkgs.stdenv.hostPlatform.system}.default];
home.file.".pi/agent/extensions/paj-rc".source = "${inputs.paj-rc}/extensions";
```

Use the compatible Paj extension described above. Once the matching Paj changes are released,
you can replace the local input with `github:jlodenius/paj-rc` and update the lock file. The Paj
integration must also be available before a GitHub-only installation is self-contained.
Reload Pi after activating the configuration. Do not additionally `pi install` the same extension
when Home Manager already manages it.

For Nix installs, use `paj-rc` wherever the source instructions below use
`node "$PAJ_RC_DIR/src/cli.js"`. One-time service setup is still explicit:

```sh
paj-rc setup --yes
```

Neither the package nor Home Manager wiring creates a pairing key, installs the user unit, starts
remote access, or changes Tailscale. Rerun setup after a Nix upgrade changes its stored executable
or source paths. Linux users without Nix can use the source installation below.

## Install from source

No npm publication exists yet. Clone or obtain this source tree, and use its absolute path:

```sh
export PAJ_RC_DIR="/absolute/path/to/paj-rc"
pi install "$PAJ_RC_DIR"
node "$PAJ_RC_DIR/src/cli.js" --help
```

Install/load the compatible Paj extension too, then restart Pi or reload extensions. `pi install`
loads a Pi package; **it does not put `paj-rc` on your shell PATH**. Commands below
therefore use `node` and the CLI source path explicitly. If a package installation later provides a
`paj-rc` binary on PATH, it accepts the same commands.

### Explicit one-time setup

Read this section before approving setup:

```sh
node "$PAJ_RC_DIR/src/cli.js" setup --yes --paj "/absolute/path/to/paj"
```

`--paj` may be omitted when `paj` is on the current setup process's PATH. Setup resolves and stores
its absolute executable path. Paths with spaces are supported. If Pi uses an explicit
`PAJ_RUNTIME_DIR`, run setup with that same environment variable: its absolute, control-free path
is preserved in the service environment so registry discovery uses the same Paj runtime root.
Rerun setup if this override changes. Setup creates:

- `$XDG_CONFIG_HOME/paj-rc/config.json`, or `~/.config/paj-rc/config.json`: private configuration
  including a random permanent pairing secret (file mode `0600`, directory `0700`). Browser login
  records are kept beside it in owner-private `browser-sessions.json`; logout remains effective
  across service restarts, and rotating the pairing key invalidates those records.
- `$XDG_CONFIG_HOME/systemd/user/paj-rc.service`, or
  `~/.config/systemd/user/paj-rc.service`: systemd user unit.
- `$XDG_RUNTIME_DIR/paj-rc`: private IPC directory, or a UID-specific private temporary directory
  when `XDG_RUNTIME_DIR` is unavailable. The socket is owner-only.

Setup runs `systemctl --user daemon-reload`. It **does not enable login startup**, start Tailscale,
change networking, or print the pairing secret. It is safe to repeat without rotating that secret.
Use a normal user shell with the user manager available, not `sudo`.

The next eligible main Pi session starts the installed service automatically. Starting additional
sessions is idempotent. An extension never installs a missing service implicitly. If setup happens
while Pi is already open, reload extensions or start a new eligible session.

Default HTTP port: **43187**, loopback only. After the last eligible session disconnects, the
service exits successfully following a **30-second** grace period. `Restart=on-failure` recovers
crashes but does not restart a successful idle exit. Login enablement or lingering is not required.
When stopped, the browser URL is unavailable until an eligible session starts it again. A newly
started service allows at least five seconds for initial registration, even with a shorter
configured idle timeout.

## Pair and use locally

With an eligible main Pi session open:

```sh
node "$PAJ_RC_DIR/src/cli.js" status
node "$PAJ_RC_DIR/src/cli.js" key
```

Open <http://127.0.0.1:43187> (or <http://localhost:43187>) and enter the key in the login form.
The key is shown **only** by the explicit `key` command. Never put it in a URL, screenshot, shared
terminal log, shell history, or reverse-proxy configuration. Pair only trusted browsers.

Select a main agent, read its visible conversation, and send plain-text instructions. Browser
reconnect or suspension must not stop agent work. A lost submission response can mean delivery is
uncertain: do not blindly resend. Busy/editor-owned sessions may reject input; unavailable dialogs
must be handled at the Pi terminal. Remote chat is not full terminal or slash-command parity.

All browser access still requires application authentication, including localhost and Tailscale.
Remote access grants the browser user the effective permissions of Pi's user and tools.

## Settings and revocation

```sh
node "$PAJ_RC_DIR/src/cli.js" settings
node "$PAJ_RC_DIR/src/cli.js" settings --port 43187 --idle-timeout-ms 30000
node "$PAJ_RC_DIR/src/cli.js" origin add "https://computer.example-tailnet.ts.net"
node "$PAJ_RC_DIR/src/cli.js" origin remove "https://computer.example-tailnet.ts.net"
node "$PAJ_RC_DIR/src/cli.js" rotate
```

`settings` and `status` never print secrets. Origins must be exact HTTPS origins or HTTP loopback
origins, without paths, trailing slash, credentials, queries, or wildcards. Port changes update
the default localhost origins, but you must update any reverse proxy yourself. Settings/origin
changes restart a running service; this briefly disconnects browsers, not Pi's ongoing work.
`idleTimeoutMs` must be an integer from 0 through 2147483647 (Node's timer limit).

`rotate` replaces the permanent pairing key and revokes browser cookies by restarting a running
service. Run `key` separately and pair trusted browsers again. If the restart fails, stop the old
service immediately (`systemctl --user stop paj-rc.service`) before relying on revocation.

Inside an eligible main Pi session, `/rc setup` asks for explicit confirmation before running
setup. `/rc status` and `/rc settings` show connectivity and sanitized configuration, with absolute
CLI commands for further changes. The CLI remains available without an installed shell binary.

## First-version limits

- Conversations render as plain text, not full terminal or Markdown widgets. History uses pages of
  up to 100 visible messages, with roughly 8 KiB of serialized text per message; large responses
  are clipped. Hidden messages, system prompts, thinking, and tool payloads are not transmitted.
- Only one not-yet-started browser submission is allowed per session. Pi's public extension input
  method returns no acceptance result. A handled input hook or failed preflight can therefore leave
  the browser showing **Awaiting Pi confirmation**, with further sends paused and Paj editor/inbox
  admission reserved. This is deliberate fail-closed behavior, not proof that Pi is still working.
- If confirmation never appears, inspect the terminal and fix the input/model/authentication cause.
  Do not blindly resend or merely refresh the browser. If dispatch remains uncertain, close and
  restart that Pi process before retrying; only process termination guarantees that an old delayed
  dispatch cannot subsequently start. A reload alone is not that guarantee.
- Prompt deduplication retains the last 512 request IDs per endpoint generation. Controls from an
  older generation are rejected. An actual Pi process restart is not a durable task queue.
- Arbitrary terminal dialogs still require desktop interaction. Browser disconnection and service
  restart do not cancel Pi work. Mobile background notifications are not implemented.

## Optional remote access: Tailscale Serve

Tailscale is optional networking infrastructure, **not** the application session authority. The
recommended remote arrangement is private tailnet HTTPS through **Serve**, with paj-rc still bound
to loopback and with its own login. Do not open the HTTP port in a firewall, bind it publicly,
or use Funnel. A generic authenticated, securely configured HTTPS reverse proxy is also possible
if it preserves the configured Host/Origin and supports streaming without buffering.

1. Install Tailscale using the [official Linux instructions](https://tailscale.com/download/linux).
   Log in on this computer and your phone to the intended tailnet. Enable MagicDNS/HTTPS if
   requested by Tailscale. Use your tailnet administrator's access policy to restrict this
   computer's HTTPS service to intended users/devices; tailnet membership may be too broad.
2. Inspect existing configuration **before making any changes**:

   ```sh
   tailscale status
   tailscale serve status
   tailscale funnel status
   ```

   If HTTPS port 443 or the root route already serves another application, do not replace it.
   Choose an unused supported HTTPS port and coordinate with its owner. Existing Funnel exposure on
   the chosen listener must be disabled deliberately before using it for paj-rc; do not assume Serve
   makes an existing public listener private. Never globally reset Serve/Funnel for this project.
3. For an unused private HTTPS listener, consult `tailscale serve --help` for your version,
   then configure a persistent loopback proxy explicitly:

   ```sh
   tailscale serve --bg http://127.0.0.1:43187
   tailscale serve status
   tailscale funnel status
   ```

   This is a manual administrator action, never performed by paj-rc. Review the exact HTTPS URL in
   the output. If you selected another HTTPS port, use its supported `--https=PORT` option and
   include that port in the allowed origin. Serve may remain configured while paj-rc is idle.
4. Add the **exact origin** shown by Serve (no trailing slash), for example:

   ```sh
   node "$PAJ_RC_DIR/src/cli.js" origin add "https://computer.example-tailnet.ts.net"
   ```

5. With Pi open, visit that HTTPS URL from the phone while connected to the tailnet. Enter the
   paj-rc pairing key. Verify history, streaming, suspension/reconnect, and session replacement.
   Check `tailscale funnel status` again to verify the listener is not publicly exposed. Test access
   from a device outside the tailnet to confirm it cannot reach the application.

See [Serve documentation](https://tailscale.com/docs/features/tailscale-serve) and the
[Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve). Tailscale versions
and access policies differ; inspect existing settings and the installed help before changing them.
Use HTTPS for remote cookies and transport; plain HTTP is supported only for local loopback use.
Never trust Tailscale identity headers as a replacement for the pairing login.

## Troubleshooting

```sh
node "$PAJ_RC_DIR/src/cli.js" status
systemctl --user status paj-rc.service
journalctl --user -u paj-rc.service --since today
```

- **No service:** run explicit setup, then open/reload an eligible interactive main session. Missing
  configuration is not automatically installed. Check that Node and Paj paths still exist.
- **No agents:** verify the matching Paj integration is loaded, the session is primary and live, and
  an editor request is not holding admission. Children never substitute for missing main sessions.
- **User bus unavailable:** use your distribution's normal logged-in user session with a systemd
  user manager. Do not work around this by running the server as root or exposing it publicly.
- **Remote 403/invalid origin:** add the exact HTTPS origin, including any nondefault port.
  Configure proxies to preserve Host/Origin; never add wildcard CORS or disable authentication.
- **Phone cannot connect:** check tailnet login, access policy, Serve status, allowed origin, and
  that an eligible Pi session is keeping the service alive. Browser closure does not keep it alive.
- **Repeated crashes:** inspect the journal and fix paths/config/port conflicts. systemd startup
  rate limits may require `systemctl --user reset-failed paj-rc.service` after fixing the cause.
- **Secrets compromised:** stop the service, rotate the key, and review who had access. Local
  same-user processes are inside the trust boundary and can read the private key/control Pi.

Avoid posting private config, pairing keys, cookies, or transcripts in bug reports.

## Uninstall

```sh
node "$PAJ_RC_DIR/src/cli.js" uninstall --yes
pi remove "$PAJ_RC_DIR"
```

Uninstall stops/disables and removes only the paj-rc user unit, then reloads systemd. It retains the
private config so reinstall preserves pairing unless you deliberately remove that file or rotate.
It never changes Tailscale. If you added a Serve route, inspect status and use your installed CLI's
route/listener-specific removal command for **only that route**; do not globally reset Serve.

## Development

```sh
npm test
node --test tests/config.test.js tests/service.test.js
```

The optional real-browser smoke test (`tests/browser-real.test.js`) uses a supplied Chromium binary:

```sh
PAJ_RC_BROWSER_BIN=/path/to/chromium npm test
```

Smoke status: the rendered default unit passed `systemd-analyze --user verify` without installation.
A real Chromium run at phone-screen size exercised pairing, session selection, and submission.
An isolated Pi RPC process loaded both source extensions successfully without making model calls
or installing services. These checks are not a real interactive deployment: phone, Tailscale Serve,
and installed user-service operation still require validation.

Tests use temporary directories and injected service executors. Do not run real setup, change your
user service/network configuration, or expose a live Pi session merely to run the test suite.
