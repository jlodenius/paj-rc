# paj-rc

`paj-rc` lets you remotely control your running main [Pi](https://github.com/badlogic/pi-mono)
sessions from your phone or browser through [Paj](https://github.com/jlodenius/paj).

## Install

Requires Linux with a systemd user manager, Node.js 22.19 or newer, Pi 1.2.x, and the latest
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
