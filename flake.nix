{
  description = "Infinite Minesweeper - a no-guess infinite minesweeper webapp";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      flake-parts,
      git-hooks,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      imports = [ inputs.git-hooks.flakeModule ];
      perSystem =
        {
          pkgs,
          lib,
          system,
          ...
        }:
        let
          version = "0.1.0";

          # Source without build artifacts so the pre-commit fallback
          # `git add .` never tracks node_modules or dist
          sourceFilter =
            name: _type:
            let
              relPath = lib.removePrefix (toString ./.) (toString name);
            in
            !(lib.hasInfix "/node_modules" relPath) && !(lib.hasInfix "/dist" relPath);

          cleanedSource = lib.cleanSourceWith {
            src = ./.;
            filter = sourceFilter;
          };

          # Static site: tsc from nixpkgs, no npm needed for the build
          sitePackage = pkgs.stdenv.mkDerivation {
            pname = "infinite-minesweeper";
            inherit version;
            src = cleanedSource;
            nativeBuildInputs = [ pkgs.typescript ];
            buildPhase = "tsc -p tsconfig.build.json";
            installPhase = ''
              mkdir -p $out
              cp -r dist/. $out/
              cp src/index.html src/style.css $out/
            '';
          };

          # PRE-COMMIT CHECK = SINGLE SOURCE OF TRUTH (git-hooks.nix)
          preCommitCheckBase = git-hooks.lib.${system}.run {
            src = cleanedSource;
            package = pkgs.prek;
            hooks = {
              nixfmt = {
                enable = true;
                package = pkgs.nixfmt;
              };
              statix.enable = true;
              prettier = {
                enable = true;
                package = pkgs.prettier;
                entry = "prettier --write";
                files = "\\.(ts|js|mjs|css|html|json|md|ya?ml)$";
                excludes = [
                  "^flake\\.lock$"
                  "^package-lock\\.json$"
                  "^node_modules/"
                  "^dist/"
                ];
              };
            };
          };

          # Custom check derivation that includes enabledPackages in build inputs
          preCommitCheck =
            pkgs.runCommand "pre-commit-check"
              {
                buildInputs = [
                  pkgs.prek
                  pkgs.git
                ]
                ++ preCommitCheckBase.enabledPackages;
                PRE_COMMIT_CONFIG_FILE = preCommitCheckBase.config.configFile;
                # Fix permission issues with prek cache
                HOME = "/tmp";
                PRE_COMMIT_HOME = "/tmp/pre-commit-cache";
                # Copy source to have .git directory
                src = cleanedSource;
              }
              ''
                mkdir -p $PRE_COMMIT_HOME
                mkdir -p $out
                # Copy source to working directory to have .git
                cp -r $src/* .
                cp -r $src/.git . 2>/dev/null || true
                # Initialize git if not present
                if [ ! -d .git ]; then
                  git init
                  git config user.email "test@test.com"
                  git config user.name "Test"
                  git add .
                  git commit -m "initial" --no-verify
                fi
                ${pkgs.lib.getExe pkgs.prek} run --all-files --config $PRE_COMMIT_CONFIG_FILE
                echo "pre-commit check passed" > $out/result
              '';

          # Formatter DERIVED from pre-commit check - as a derivation with tools in PATH
          formatter =
            pkgs.runCommand "pre-commit-run"
              {
                buildInputs = [ pkgs.prek ] ++ preCommitCheckBase.enabledPackages;
              }
              ''
                mkdir -p $out/bin
                echo '#!/usr/bin/env bash' > $out/bin/pre-commit-run
                echo 'mkdir -p /tmp/pre-commit-cache' >> $out/bin/pre-commit-run
                echo 'HOME=/tmp PRE_COMMIT_HOME=/tmp/pre-commit-cache ${pkgs.lib.getExe pkgs.prek} run --all-files --config ${preCommitCheckBase.config.configFile}' >> $out/bin/pre-commit-run
                chmod +x $out/bin/pre-commit-run
              '';

          commonDevPackages = with pkgs; [
            git
            nodejs
            python3
            direnv
            nix
            nixfmt
            statix
            jq
            fzf
            ripgrep
            fd
            bat
            delta
            httpie
            curl
            wget
            prettier
            semgrep
            trivy
            git-secrets
          ];
        in
        {
          config = {
            # Dev shell
            devShells.default = pkgs.mkShell {
              name = "infinite-minesweeper-dev";
              packages = commonDevPackages ++ preCommitCheckBase.enabledPackages ++ [ formatter ];
              shellHook = preCommitCheckBase.shellHook + ''
                eval "$(direnv hook ${pkgs.bash}/bin/bash)"

                echo "Minesweeper∞ development environment"
                echo ""
                echo "Available commands:"
                echo "  npm ci               - Install dev dependencies"
                echo "  npm run dev          - Watch-compile the site into dist/"
                echo "  npm run serve        - Serve dist/ (uses python http.server)"
                echo "  npm test             - Run unit tests (vitest)"
                echo "  npm run lint         - ESLint"
                echo "  nix flake check      - Run all flake checks"
                echo "  pre-commit-run       - Run pre-commit hooks"
                echo "  just build           - Build the static site via nix"
              '';
            };

            # Formatter
            inherit formatter;

            packages = {
              default = sitePackage;
              site = sitePackage;
            };

            # Checks - override git-hooks auto pre-commit with our version
            checks = {
              site = sitePackage;
              inherit preCommitCheck;
              "pre-commit" = lib.mkForce preCommitCheck;
            };
          };
        };
    };
}
