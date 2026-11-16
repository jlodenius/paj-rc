# paj-rc

`paj-rc` lets you remotely control your running main [Pi](https://github.com/badlogic/pi-mono)
sessions from your phone or browser through [Paj](https://github.com/jlodenius/paj).

## Install

Requires Linux with a systemd user manager, Node.js 22.19 or newer, Pi 1.2 or newer, and the latest
[Paj CLI and Pi extension](https://github.com/jlodenius/paj#install).

Install the CLI and the Pi extension separately:

```sh
npm install -g git+https://github.com/jlodenius/paj-rc.git
pi install git:github.com/jlodenius/paj-rc
```

### NixOS

On NixOS with Home Manager, use this instead of the commands above. Add the GitHub flake input:

```nix
inputs.paj-rc = {
  url = "github:jlodenius/paj-rc";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

In your Home Manager user configuration, with `inputs` available in the module scope:

```nix
home.packages = [inputs.paj-rc.packages.${pkgs.stdenv.hostPlatform.system}.default];
home.file.".pi/agent/extensions/paj-rc".source = "${inputs.paj-rc}";
```

The flake includes Node. Rebuild NixOS, then continue below. Home Manager loads the extension.

## Setup

In Pi, reload extensions and approve the one-time user-service setup:

```text
/reload
/rc setup
```

With a main Pi session open, check the service and show your pairing key:

```sh
paj-rc status
paj-rc key
```

Open <http://127.0.0.1:43187> and enter the key. Pair only trusted browsers: they can control Pi
and its tools. Treat the key like a password. Your browser remembers its pairing.

## Skills and prompts

Select a session and type `/` to browse its loaded skills and prompt templates. Tap a suggestion,
or use arrow keys and Enter/Tab, to insert it without sending. Add arguments, then send normally:

```text
/skill:research investigate this API
/review "API compatibility"
```

Pi expands the selected skill or template, including when steering or queueing a follow-up. Terminal
commands are not offered. After updating the extension, reload it and refresh the browser to load
command suggestions; older adapters provide none.

## Safety and privacy

Paired browsers control live main sessions; subagents are not exposed. Closing the browser does
not stop work. Submitted or queued messages do not prove execution, and uncertain writes are never
automatically retried.

Only the public app shell is cached for offline use, not conversations, credentials, photos, or
writes. Photos stay in memory in the browser; Pi and its provider handle submitted images as normal
user input. Context counts are Pi's estimates, not billing totals.

## Remote access with Tailscale

Install Tailscale on your computer and phone, and sign in to the same tailnet. Check existing
routes before configuring private HTTPS access; do not replace another application's route or use
public Funnel:

```sh
tailscale serve status
tailscale funnel status
sudo tailscale serve --bg http://127.0.0.1:43187
```

Add the exact HTTPS origin printed by Serve, without a trailing slash:

```sh
paj-rc origin add https://your-computer.your-tailnet.ts.net
```

With Pi open and Tailscale connected, visit that address on your phone and pair using the same key.
To install the app on your home screen:

- **iPhone/iPad:** Safari → Share → Add to Home Screen.
- **Android:** Chrome menu → Install app or Add to Home screen.
