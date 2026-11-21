# paj-rc service setup

[Back to pairing](../README.md#pair).

For Nix, add `github:jlodenius/paj-rc` as a flake input named `paj-rc`, then use Home Manager:

```nix
home.packages = [inputs.paj-rc.packages.${pkgs.stdenv.hostPlatform.system}.default];
home.file.".pi/agent/extensions/paj-rc".source =
  "${inputs.paj-rc.packages.${pkgs.stdenv.hostPlatform.system}.default}/lib/node_modules/paj-rc";
```

With Home Manager, skip `pi install` for paj-rc.

## Home Manager service

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

Keep `$XDG_CONFIG_HOME/paj-rc/` out of Nix; it holds private settings, the pairing key, and browser
sessions. `serve --paj` uses the executable pinned in the unit without changing that config.
Use Home Manager to change or remove the managed unit.

## Changing the shared Paj runtime

If you change the [shared Paj runtime](https://github.com/jlodenius/paj#shared-runtime), start Pi
with the new absolute `PAJ_RUNTIME_DIR`. Update a declarative unit through Home Manager, or rerun
`/rc setup` for a standalone unit. Changing your shell alone does not update the service. If the
service is already running, restart it with `systemctl --user try-restart paj-rc.service`, then
check `/rc status`.
