{
  description = "Private browser control for live main Paj and Pi sessions";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs ["aarch64-linux" "x86_64-linux"];
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.buildNpmPackage {
        pname = "paj-rc";
        version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
        src = self;
        npmDepsHash = "sha256-wbRqlQtzz8p/OlXRutNt3dFQh8Mux5e0NMj7qFpWN50=";
        nativeBuildInputs = [pkgs.makeWrapper];
        npmBuildScript = "build";
        doCheck = true;
        checkPhase = ''
          runHook preCheck
          export HOME="$TMPDIR/home"
          mkdir -p "$HOME"
          node --test tests/*.test.js
          runHook postCheck
        '';
        postInstall = ''
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
