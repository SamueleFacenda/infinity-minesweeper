# Justfile - Command runner for the infinite minesweeper webapp

# Default target
default: help

# Help
help:
	@just --list

# Development
dev-shell:
	nix develop

dev-shell-impure:
	nix develop --impure

# Formatting & Linting (via pre-commit from flake)
fmt:
	pre-commit-run

fmt-check:
	pre-commit-run

# Install dev dependencies (node_modules for vitest/eslint)
deps:
	nix develop -c bash -c "npm ci"

# Testing
test:
	nix develop -c bash -c "npm test"

test-watch:
	nix develop -c bash -c "npm run test:watch"

# Type checking
type-check:
	nix develop -c bash -c "npm run typecheck"

# Build the static site via nix
build:
	nix build .#site

# Serve the compiled site for local play
serve:
	nix develop -c bash -c "npm run build && npm run serve"

# Dependency management
deps-check:
	@echo "Checking for outdated dev dependencies..."
	nix develop -c bash -c "npm outdated"

# Git
git-status:
	git status

git-diff:
	git diff

git-log:
	git log --oneline -20

# AI agents
opencode:
	opencode

claude:
	claude

# Clean
clean:
	@echo "Cleaning build artifacts..."
	rm -rf node_modules dist .cache
