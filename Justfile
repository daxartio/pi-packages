# List available development commands.
default:
    @just --list

# Format, organize imports, and apply safe lint fixes.
biome-format:
    biome check --write "{{ justfile_directory() }}"

alias format := biome-format

# Check formatting, lint rules, and imports without modifying files.
biome-ci:
    biome ci --error-on-warnings "{{ justfile_directory() }}"

# Run lint checks without modifying files.
lint:
    biome lint --error-on-warnings "{{ justfile_directory() }}"

# Check the entire repository and each package's compiler configuration.
typecheck:
    bun run typecheck
    bun run --workspaces --if-present typecheck

# Run each package's tests with its declared test runner.
test:
    bun run --workspaces --if-present test

# Run tests for one workspace, for example: just test-package pi-subagents.
test-package package:
    bun run --filter "{{ package }}" test

# Run all non-mutating validation steps.
check: biome-ci typecheck test
