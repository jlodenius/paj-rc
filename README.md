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

Install from npm first, not from a raw checkout via Pi. For Nix, see
[Home Manager installation and service setup](docs/service.md).

## Pair

In a live, interactive main Pi session registered with Paj, run `/reload`. Then run
`/rc setup` for a standalone service. Skip setup if Home Manager owns the unit.
Eligible Pi sessions start the service on demand.

```sh
paj-rc status
paj-rc key
```

Open <http://127.0.0.1:43187>, enter the key, and check that your session's conversation appears.
**Keep the key private:** paired browsers can control Pi and its tools.
Run `paj-rc rotate` to revoke paired browsers and replace the key.

Missing session? Check `/rc status` in Pi and `paj --json session list --all` in the same
environment. If you changed `PAJ_RUNTIME_DIR`,
[update the service too](docs/service.md#changing-the-shared-paj-runtime).

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

## Reference

- [Browser controls, privacy, and development](docs/reference.md)
- [Home Manager service configuration](docs/service.md#home-manager-service)
