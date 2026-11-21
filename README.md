# paj-rc

Private browser control for live main [Pi](https://github.com/earendil-works/pi) sessions through
[Paj](https://github.com/jlodenius/paj). Requires Linux, a systemd user manager, Node.js 22.19+,
Pi 1.2+, and the latest Paj CLI and extension.

## Install

First [install the Paj CLI and Pi extension](https://github.com/jlodenius/paj#install).
Keep `paj` on the Pi session's `PATH`.

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

With Home Manager, skip `pi install` for paj-rc.

### Home Manager–managed user service

Installing the package and extension through Home Manager does not by itself manage the service.
To let Home Manager own it too, define `systemd.user.services.paj-rc` in your Home Manager module.
This example uses the same pinned packages as your `home.packages` and Pi extension setup:

```nix
{ inputs, pkgs, ... }:
let
  system = pkgs.stdenv.hostPlatform.system;
  pajRc = inputs.paj-rc.packages.${system}.default;
  paj = inputs.paj.packages.${system}.default;
in {
  systemd.user.services.paj-rc = {
    Unit = {
      Description = "Private browser control for live Paj sessions";
      StartLimitIntervalSec = 60;
      StartLimitBurst = 5;
    };
    Service = {
      ExecStart = "${pajRc}/bin/paj-rc serve --paj ${paj}/bin/paj";
      Restart = "on-failure";
      RestartSec = 2;
      UMask = "0077";
      NoNewPrivileges = true;
    };
  };
}
```

Home Manager installs a link at `$XDG_CONFIG_HOME/systemd/user/paj-rc.service` (normally under
`~/.config`). Don't add `Install.WantedBy`: eligible Pi sessions start the service on demand,
and an idle shutdown is not a failure. If Pi uses a custom `PAJ_RUNTIME_DIR`, pass the same
value in the service's `Environment`.

A normal update of the `paj` and `paj-rc` flake inputs followed by your NixOS switch (or
Home Manager switch for a standalone Home Manager installation) updates both executable paths in
the unit. An already running daemon uses the old binaries until it restarts. If activation did
not restart it, use `systemctl --user try-restart paj-rc.service` to pick up the new paths without
starting an idle service. Reload existing Pi sessions to use their updated extensions.

Keep `$XDG_CONFIG_HOME/paj-rc/` out of Nix; it holds private settings, the pairing key, and browser
sessions. `serve --paj` uses the pinned executable instead of any old path in that directory,
without overwriting it. First start creates owner-private defaults only if no config exists.
Existing settings and paired browsers survive the switch.

**One-time handoff from standalone:** with the new unit ready to activate, stop the old user
service. If the old `paj-rc.service` in the user config directory is a regular file installed by
`paj-rc setup`, move just that file to a private backup outside the unit directory. Leave the
private `paj-rc/` config directory untouched. Activate Home Manager and check that it owns the
unit link, then reload Pi and check `/rc status`. Don't run standalone setup or uninstall while
switching. Use Home Manager to change or remove the managed unit.

## Pair

Use a live, interactive main Pi session (`primary` in Paj) with a matching Paj registration.
Subagents and noninteractive sessions are not browser targets. In Pi, run `/reload`. For a
standalone service, run `/rc setup` and approve the private user-service setup. For a Home
Manager–managed service, skip `/rc setup`: the eligible Pi session starts the configured unit.

```sh
paj-rc status
paj-rc key
```

Open <http://127.0.0.1:43187> and enter the key. Treat it like a password: paired browsers can control
Pi and its tools. Select your main session and check that its conversation appears.
The service starts on demand, not at login. If your session is missing, check `/rc status` in Pi
and confirm the session appears in `paj --json session list --all` from the same environment.
Use `paj-rc --help` for settings and revocation.

If you change the [shared Paj runtime](https://github.com/jlodenius/paj#shared-runtime), start Pi
with the new absolute `PAJ_RUNTIME_DIR`. Update a declarative unit through Home Manager, or rerun
`/rc setup` for a standalone unit. Changing your shell alone does not update the service. If the
service is already running, restart it with `systemctl --user try-restart paj-rc.service`, then
check `/rc status`.

Select a session and type `/` for loaded extension commands, skills, and prompt templates. The list
loads in bounded pages rather than stopping after 128 entries. Insert a suggestion, add arguments,
then send. Steering and follow-ups require an explicit choice; uncertain writes are never retried.

Use **All / Working / Idle** to filter the list without changing the selected conversation. Working
and Idle use the session's explicit busy state; unknown or disconnected status appears only in All.
Captain sessions remain first within each filtered list.

Extension commands execute immediately, not as steering or follow-ups, and accept text arguments only.
“Submitted” acknowledges dispatch, not completion or success. Dialogs, notifications, and command errors
remain in Pi's terminal; the browser shows when terminal interaction is required. Arbitrary custom
terminal screens and built-in interactive commands such as `/model` are not browser interfaces.
Command names must contain no whitespace or control characters and fit the 16,000-character input
limit. Unsupported catalog entries do not hide other commands; invoking one is rejected, not sent to
the model as ordinary text.

A **Captain** badge marks sessions with the live [Captain](https://github.com/jlodenius/paj-captain)
capability. It follows the existing registry
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
