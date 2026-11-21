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

## Changing the shared Paj runtime

If you change the [shared Paj runtime](https://github.com/jlodenius/paj#shared-runtime), start Pi
with the new absolute `PAJ_RUNTIME_DIR`. Update a declarative unit through Home Manager, or rerun
`/rc setup` for a standalone unit. Changing your shell alone does not update the service. If the
service is already running, restart it with `systemctl --user try-restart paj-rc.service`, then
check `/rc status`.
