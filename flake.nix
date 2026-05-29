{
  description = "Hugo's static blog generator";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        pythonEnv = pkgs.python3.withPackages (ps: with ps; [
          click
          jinja2
          pygments
          pillow
          dataclasses-json
          black
        ]);

        blog = pkgs.stdenv.mkDerivation {
          pname = "blog";
          version = "0.1.0";

          src = pkgs.lib.cleanSource ./.;

          nativeBuildInputs = [ pythonEnv pkgs.gifsicle ];

          buildPhase = ''
            python3 main.py build
          '';

          installPhase = ''
            cp -r ignore/build $out
          '';
        };
      in
      {
        packages = {
          default = blog;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            pythonEnv
            pkgs.gifsicle
          ];

          shellHook = ''
            echo "blog dev shell ready"
          '';
        };
      }
    );
}
