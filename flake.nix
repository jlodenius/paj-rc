{
  description = "Private browser control for live main Paj and Pi sessions";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    forAllSystems = nixpkgs.lib.genAttrs ["aarch64-linux" "x86_64-linux"];
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.buildNpmPackage {
        pname = "paj-rc";
        inherit ((builtins.fromJSON (builtins.readFile ./package.json))) version;
        src = self;
        npmDepsHash = "sha256-CkbJdDo2c2JVknQM87n21qRppLX9e/sK2psI4h4T6Us=";
        nativeBuildInputs = [pkgs.makeWrapper];
        npmBuildScript = "build";
        doCheck = true;
        checkPhase = ''
          runHook preCheck
          export HOME="$TMPDIR/home"
          mkdir -p "$HOME"
          npm run typecheck
          node --test tests/*.test.js
          runHook postCheck
        '';
        postInstall = ''
          test ! -e "$out/lib/node_modules/paj-rc/node_modules/@earendil-works/pi-coding-agent"
          test ! -e "$out/lib/node_modules/paj-rc/node_modules/typebox"
          wrapProgram "$out/bin/paj-rc" \
            --prefix PATH : ${pkgs.lib.makeBinPath [pkgs.systemd]}
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
