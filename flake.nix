{
  description = "Private browser control for live main Paj and Pi sessions";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    forAllSystems = nixpkgs.lib.genAttrs [
      "aarch64-linux"
      "x86_64-linux"
    ];
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.stdenvNoCC.mkDerivation {
        pname = "paj-rc";
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
        src = self;

        nativeBuildInputs = [pkgs.makeWrapper];
        nativeCheckInputs = [pkgs.nodejs];
        dontConfigure = true;
        dontBuild = true;
        doCheck = true;

        checkPhase = ''
          runHook preCheck
          export HOME="$TMPDIR/home"
          mkdir -p "$HOME"
          node --test tests/*.test.js
          runHook postCheck
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/share/paj-rc" "$out/bin"
          cp -r extensions src public package.json README.md "$out/share/paj-rc/"
          makeWrapper ${pkgs.nodejs}/bin/node "$out/bin/paj-rc" \
            --add-flags "$out/share/paj-rc/src/cli.js" \
            --prefix PATH : ${pkgs.lib.makeBinPath [pkgs.systemd]}
          runHook postInstall
        '';

        meta = {
          description = "Private browser control for live main Paj and Pi sessions";
          mainProgram = "paj-rc";
          platforms = pkgs.lib.platforms.linux;
        };
      };
    });

    checks = forAllSystems (system: {
      default = self.packages.${system}.default;
    });
  };
}
