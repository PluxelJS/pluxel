#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
BASE_REF="${1:-${PLUXEL_BENCH_COMPARE_BASE:-}}"
HEAD_REF="${2:-${PLUXEL_BENCH_COMPARE_HEAD:-HEAD}}"
DEFAULT_BRANCH="${PLUXEL_BENCH_DEFAULT_BRANCH:-main}"

is_empty_ref() {
	local value="${1:-}"
	[ -z "$value" ] || [[ "$value" =~ ^0+$ ]]
}

if is_empty_ref "$BASE_REF"; then
	if git rev-parse --verify --quiet "origin/${DEFAULT_BRANCH}" >/dev/null; then
		BASE_REF="$(git merge-base "$HEAD_REF" "origin/${DEFAULT_BRANCH}")"
	else
		BASE_REF="$(git rev-parse "${HEAD_REF}^")"
	fi
fi

BASE_SHA="$(git rev-parse "$BASE_REF")"
HEAD_SHA="$(git rev-parse "$HEAD_REF")"
CURRENT_SHA="$(git rev-parse HEAD)"

WORK_ROOT="${PLUXEL_BENCH_WORKDIR:-${TMPDIR:-/tmp}/pluxel-core-bench-${USER:-user}}"
BASE_DIR="${WORK_ROOT}/core-base"
HEAD_DIR="$ROOT"
HEAD_WORKTREE_DIR="${WORK_ROOT}/core-head"
RESULT_ROOT="${PLUXEL_BENCH_RESULT_DIR:-${ROOT}/.bench-results/core}"
BASE_RESULT_DIR="${RESULT_ROOT}/base"
HEAD_RESULT_DIR="${RESULT_ROOT}/head"
REFERENCE_REPORT="${BASE_RESULT_DIR}/plugin-lifecycle.json"

cleanup() {
	if [ "${PLUXEL_BENCH_KEEP_WORKTREES:-0}" != "1" ]; then
		git -C "$ROOT" worktree remove --force "$BASE_DIR" >/dev/null 2>&1 || true
		git -C "$ROOT" worktree remove --force "$HEAD_WORKTREE_DIR" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT

rm -rf "$BASE_DIR" "$HEAD_WORKTREE_DIR" "$BASE_RESULT_DIR" "$HEAD_RESULT_DIR"
mkdir -p "$WORK_ROOT" "$BASE_RESULT_DIR" "$HEAD_RESULT_DIR"

echo "[bench] base: $BASE_SHA"
echo "[bench] head: $HEAD_SHA"
git worktree add --detach "$BASE_DIR" "$BASE_SHA" >/dev/null
if [ "$HEAD_SHA" != "$CURRENT_SHA" ]; then
	HEAD_DIR="$HEAD_WORKTREE_DIR"
	git worktree add --detach "$HEAD_DIR" "$HEAD_SHA" >/dev/null
fi

run_bench() {
	local label="$1"
	local dir="$2"
	local output_dir="$3"
	local reference="${4:-}"
	local install_log="${output_dir}/install.log"
	local log_file="${output_dir}/bench.log"

	echo "[bench] running ${label} in ${dir}"
	pushd "$dir" >/dev/null

	if [ "${PLUXEL_BENCH_SKIP_INSTALL:-0}" != "1" ]; then
		if ! pnpm install --frozen-lockfile >"$install_log" 2>&1; then
			tail -200 "$install_log"
			return 1
		fi
		echo "[bench] ${label} install log: ${install_log}"
	fi

	if [ -n "$reference" ]; then
		if ! PLUXEL_BENCH_OUTPUT_DIR="$output_dir" \
			PLUXEL_BENCH_REFERENCE="$reference" \
			pnpm --filter @pluxel/core bench:dist >"$log_file" 2>&1; then
			tail -200 "$log_file"
			return 1
		fi
	else
		if ! PLUXEL_BENCH_OUTPUT_DIR="$output_dir" \
			PLUXEL_BENCH_STRICT=0 \
			pnpm --filter @pluxel/core bench:dist >"$log_file" 2>&1; then
			tail -200 "$log_file"
			return 1
		fi
	fi
	echo "[bench] ${label} log: ${log_file}"

	if [ ! -f "${output_dir}/plugin-lifecycle.json" ] && [ -f "packages/core/benchmarks/plugin-lifecycle.json" ]; then
		cp packages/core/benchmarks/plugin-lifecycle.* "$output_dir"/ 2>/dev/null || true
	fi

	popd >/dev/null
}

run_bench "base" "$BASE_DIR" "$BASE_RESULT_DIR"
run_bench "head" "$HEAD_DIR" "$HEAD_RESULT_DIR" "$REFERENCE_REPORT"

echo "[bench] report: ${HEAD_RESULT_DIR}/plugin-lifecycle.md"
