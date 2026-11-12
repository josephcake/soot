#!/usr/bin/env bash
# Local equivalent of .github/workflows/ci.yml. Keep the two in sync
# (tests/repo-structure.test.ts enforces that the same steps appear in both).
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$*"; }

step "node $(node --version), pnpm $(pnpm --version)"
step "install";      pnpm install --frozen-lockfile
step "typecheck";    pnpm run typecheck
step "lint";         pnpm run lint
step "format check"; pnpm run format:check
step "test";         pnpm run test
step "build";        pnpm run clean && pnpm run build

printf '\nCI checks passed.\n'
