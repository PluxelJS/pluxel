#!/usr/bin/env bash
set -euo pipefail

# Outputs:
# - mode=full|affected
# - filter_ref=<git ref> (only when affected)
#
# Notes:
# - Always run full suite on main to keep cache warm and surface regressions.
# - For PRs, try to run only tasks affected since the PR base branch.

DEFAULT_BASE="${DEFAULT_BASE:-main}"
PR_BASE_REF="${PR_BASE_REF:-}"

current_ref="${GITHUB_REF:-}"
if [ "$current_ref" = "refs/heads/main" ]; then
  echo "mode=full" >> "${GITHUB_OUTPUT:?}"
  exit 0
fi

base_branch="${PR_BASE_REF:-$DEFAULT_BASE}"
base_ref="origin/$base_branch"

git fetch --no-tags --depth=1 origin "$base_branch:$base_branch" >/dev/null 2>&1 || true

tmpfile="$(mktemp)"
cleanup() { rm -f "$tmpfile"; }
trap cleanup EXIT

if pnpm -w turbo run test "--filter=...[$base_ref]" --dry-run=json >"$tmpfile" 2>/dev/null; then
  tasks="$(jq '.tasks | length' "$tmpfile" 2>/dev/null || echo 0)"
  if [ "${tasks:-0}" -gt 0 ]; then
    echo "mode=affected" >> "${GITHUB_OUTPUT:?}"
    echo "filter_ref=$base_ref" >> "${GITHUB_OUTPUT:?}"
    exit 0
  fi
fi

echo "mode=full" >> "${GITHUB_OUTPUT:?}"
