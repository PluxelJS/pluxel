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

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 24 ]; then
	echo "[bench] Node 24 or newer is required; found $(node --version)." >&2
	exit 1
fi

WORK_ROOT="${PLUXEL_BENCH_WORKDIR:-${TMPDIR:-/tmp}/pluxel-core-bench-${USER:-user}}"
BASE_DIR="${WORK_ROOT}/core-base"
HEAD_DIR="${WORK_ROOT}/core-head"
RESULT_ROOT="${PLUXEL_BENCH_RESULT_DIR:-${ROOT}/.bench-results/core}"
BASE_RESULT_DIR="${RESULT_ROOT}/base"
HEAD_RESULT_DIR="${RESULT_ROOT}/head"
REFERENCE_REPORT="${BASE_RESULT_DIR}/plugin-lifecycle.json"

cleanup() {
	if [ "${PLUXEL_BENCH_KEEP_WORKTREES:-0}" != "1" ]; then
		git -C "$ROOT" worktree remove --force "$BASE_DIR" >/dev/null 2>&1 || true
		git -C "$ROOT" worktree remove --force "$HEAD_DIR" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT

rm -rf \
	"$BASE_DIR" \
	"$HEAD_DIR" \
	"$BASE_RESULT_DIR" \
	"$HEAD_RESULT_DIR"
mkdir -p \
	"$WORK_ROOT" \
	"$BASE_RESULT_DIR" \
	"$HEAD_RESULT_DIR"

echo "[bench] base: $BASE_SHA"
echo "[bench] head: $HEAD_SHA"
git worktree add --detach "$BASE_DIR" "$BASE_SHA" >/dev/null
git worktree add --detach "$HEAD_DIR" "$HEAD_SHA" >/dev/null

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
		git submodule update --init --recursive
		# Native task discovery loads configuration across the workspace, so it needs all
		# configuration dependencies even though only the measured artifact owners are built.
		if ! vp install --frozen-lockfile >"$install_log" 2>&1; then
			tail -200 "$install_log"
			return 1
		fi
		echo "[bench] ${label} install log: ${install_log}"
	fi

	# Build with each revision's package-local Pack config. Its build scripts may discover
	# unrelated historical Vite task configs before their workspace plugins exist.
	# pnpm preserves dependency order for these measured owners; registry eventure revisions
	# already have its artifact. Dependency-wide recursion would also build dev-only helpers.
	if ! pnpm --recursive --filter eventure --filter @pluxel/context --filter @pluxel/core \
		--fail-if-no-match exec vp pack >"$log_file" 2>&1; then
		tail -200 "$log_file"
		return 1
	fi

	if [ -n "$reference" ]; then
		if ! PLUXEL_BENCH_OUTPUT_DIR="$output_dir" \
			PLUXEL_BENCH_REFERENCE="$reference" \
			node --experimental-strip-types packages/core/bench/pluginLifecycle.bench.ts >>"$log_file" 2>&1; then
			tail -200 "$log_file"
			return 1
		fi
	else
		if ! PLUXEL_BENCH_OUTPUT_DIR="$output_dir" \
			PLUXEL_BENCH_STRICT=0 \
			node --experimental-strip-types packages/core/bench/pluginLifecycle.bench.ts >>"$log_file" 2>&1; then
			tail -200 "$log_file"
			return 1
		fi
	fi
	echo "[bench] ${label} log: ${log_file}"

	popd >/dev/null
}

run_bench "base" "$BASE_DIR" "$BASE_RESULT_DIR"

run_bench "head" "$HEAD_DIR" "$HEAD_RESULT_DIR" "$REFERENCE_REPORT"

echo "[bench] report: ${HEAD_RESULT_DIR}/plugin-lifecycle.md"

REFERENCE_STATUS="$(
	node -e '
		const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
		process.stdout.write(report.reference?.status ?? "none")
	' "$HEAD_RESULT_DIR/plugin-lifecycle.json"
)"
if [ "$REFERENCE_STATUS" != "compatible" ]; then
	echo "[bench] No compatible base/head reference was produced; performance deltas are unavailable." >&2
	exit 2
fi
