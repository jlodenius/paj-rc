# paj-rc

Private browser control for live main [Pi](https://github.com/earendil-works/pi) sessions through
[Paj](https://github.com/jlodenius/paj). Requires Linux, a systemd user manager, Node.js 22.19+,
Pi 1.2+, and the latest Paj CLI and extension.

## Install

```sh
npm install -g git+https://github.com/jlodenius/paj-rc.git
pi install "$(npm root -g)/paj-rc"
```

The npm Git installation builds TypeScript, then Pi loads that compiled package. Do not install the
raw Git checkout directly with Pi: its production-only dependency install cannot build the sources.
Published packages contain Node and browser JavaScript in `dist/`; generated JS is not source.

For Nix, add `github:jlodenius/paj-rc` as a flake input named `paj-rc`, then use Home Manager:

```nix
home.packages = [inputs.paj-rc.packages.${pkgs.stdenv.hostPlatform.system}.default];
home.file.".pi/agent/extensions/paj-rc".source =
  "${inputs.paj-rc.packages.${pkgs.stdenv.hostPlatform.system}.default}/lib/node_modules/paj-rc";
```

## Pair

In an eligible main Pi TUI, reload and approve the one-time private user-service setup:

```text
/reload
/rc setup
```

```sh
paj-rc status
paj-rc key
```

Open <http://127.0.0.1:43187> and enter the key. Treat it like a password: paired browsers can control
Pi and its tools. The service is not enabled at login. Use `paj-rc --help` for settings and revocation.

Select a session and type `/` for skills and prompt templates. Insert a suggestion, add arguments,
then send. Steering and follow-ups require an explicit choice; uncertain writes are never retried.

A **Captain** badge marks sessions with Paj's live Captain capability. It follows the existing registry
poll (normally every five seconds), not names or historic mode entries. Missing, malformed, or stale
capabilities show no badge; badges are hidden while reconnecting or awaiting a fresh session list.
This is an advisory capability indicator, not authorization or an instantaneous runtime-mode guarantee.

## Private remote access

With Tailscale installed on both devices, inspect existing routes before adding private HTTPS.
Do not replace another application's route or enable public Funnel.

```sh
tailscale serve status
tailscale funnel status
sudo tailscale serve --bg http://127.0.0.1:43187
paj-rc origin add https://your-computer.your-tailnet.ts.net
```

Use the exact HTTPS origin from Serve, without a trailing slash. Pair there, then use your browser's
Add to Home Screen or Install App action.

## Privacy

Only the public app shell is cached, never credentials, conversations, photos, or writes. Photos stay
in browser memory until submitted; Pi and its provider then handle them as normal input. Closing the
browser does not stop work. Context counts are estimates, not billing totals.

## Develop

```sh
npm ci --cache .cache/npm
npm run typecheck
npm test
nix build
```

Node sources live in `src/`, browser sources in `browser/`, and the Pi entry in `extensions/`.
Typechecking covers all three using the pinned development SDK; it is not shipped at runtime.
The build emits executable browser JavaScript and copies static assets to `dist/public/`.
Optional integration tests use `PAJ_RC_PI_BIN`, `PAJ_RC_PI_MODULE`, or `PAJ_RC_BROWSER_BIN`; no
sibling checkout is required.
