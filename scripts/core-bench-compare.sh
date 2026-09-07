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

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 24 ]; then
	echo "[bench] Node 24 or newer is required; found $(node --version)." >&2
	exit 1
fi

WORK_ROOT="${PLUXEL_BENCH_WORKDIR:-${TMPDIR:-/tmp}/pluxel-core-bench-${USER:-user}}"
BASE_DIR="${WORK_ROOT}/core-base"
HEAD_DIR="$ROOT"
HEAD_WORKTREE_DIR="${WORK_ROOT}/core-head"
BRIDGE_DIR="${WORK_ROOT}/core-workload-bridge"
RESULT_ROOT="${PLUXEL_BENCH_RESULT_DIR:-${ROOT}/.bench-results/core}"
BASE_RESULT_DIR="${RESULT_ROOT}/base"
HEAD_RESULT_DIR="${RESULT_ROOT}/head"
BRIDGE_LEGACY_RESULT_DIR="${RESULT_ROOT}/bridge-legacy"
BRIDGE_CURRENT_RESULT_DIR="${RESULT_ROOT}/bridge-current"
REFERENCE_REPORT="${BASE_RESULT_DIR}/plugin-lifecycle.json"
BRIDGED_REFERENCE_REPORT="${BASE_RESULT_DIR}/plugin-lifecycle.bridged.json"
# v1->v2 benchmark migration. Both harnesses run against the runtime immediately before the
# migration commit; callers can override these refs for a future workload transition.
WORKLOAD_BRIDGE_RUNTIME_REF="${PLUXEL_BENCH_BRIDGE_RUNTIME_REF:-3535fbbdd0e871fff5585859a53fcc809522d739}"
WORKLOAD_BRIDGE_SWITCH_REF="${PLUXEL_BENCH_BRIDGE_SWITCH_REF:-9c41605d023e2684938850857b7459268dabe9c9}"

cleanup() {
	if [ "${PLUXEL_BENCH_KEEP_WORKTREES:-0}" != "1" ]; then
		git -C "$ROOT" worktree remove --force "$BASE_DIR" >/dev/null 2>&1 || true
		git -C "$ROOT" worktree remove --force "$HEAD_WORKTREE_DIR" >/dev/null 2>&1 || true
		git -C "$ROOT" worktree remove --force "$BRIDGE_DIR" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT

rm -rf \
	"$BASE_DIR" \
	"$HEAD_WORKTREE_DIR" \
	"$BRIDGE_DIR" \
	"$BASE_RESULT_DIR" \
	"$HEAD_RESULT_DIR" \
	"$BRIDGE_LEGACY_RESULT_DIR" \
	"$BRIDGE_CURRENT_RESULT_DIR"
mkdir -p \
	"$WORK_ROOT" \
	"$BASE_RESULT_DIR" \
	"$HEAD_RESULT_DIR" \
	"$BRIDGE_LEGACY_RESULT_DIR" \
	"$BRIDGE_CURRENT_RESULT_DIR"

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
		if ! pnpm install --filter @pluxel/core... --frozen-lockfile >"$install_log" 2>&1; then
			tail -200 "$install_log"
			return 1
		fi
		echo "[bench] ${label} install log: ${install_log}"
	fi

	# Build historical toolchain helpers explicitly when the core config imports their dist entry.
	# The current core config is self-contained, so it skips this branch.
	if grep -q "@pluxel/rolldown" packages/core/tsdown.config.ts; then
		pnpm --filter @pluxel/rolldown build >"$log_file" 2>&1
	elif grep -q "@pluxel/build" packages/core/tsdown.config.ts; then
		pnpm --filter @pluxel/build build >"$log_file" 2>&1
	else
		: >"$log_file"
	fi
	if ! pnpm --filter @pluxel/core build >>"$log_file" 2>&1; then
		tail -200 "$log_file"
		return 1
	fi

	if [ -n "$reference" ]; then
		if ! PLUXEL_BENCH_OUTPUT_DIR="$output_dir" \
			PLUXEL_BENCH_REFERENCE="$reference" \
			PLUXEL_BENCH_BASELINE="$reference" \
			node --experimental-strip-types "$ROOT/scripts/core-bench-node-runner.mjs" \
				packages/core/bench/pluginLifecycle.bench.ts >>"$log_file" 2>&1; then
			tail -200 "$log_file"
			return 1
		fi
	else
		if ! PLUXEL_BENCH_OUTPUT_DIR="$output_dir" \
			PLUXEL_BENCH_STRICT=0 \
			node --experimental-strip-types "$ROOT/scripts/core-bench-node-runner.mjs" \
				packages/core/bench/pluginLifecycle.bench.ts >>"$log_file" 2>&1; then
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

REFERENCE_FOR_HEAD="$REFERENCE_REPORT"
BASE_WORKLOAD_ID="$(
	node -e '
		const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
		process.stdout.write(typeof report.workload?.id === "string" ? report.workload.id : "")
	' "$REFERENCE_REPORT"
)"

if [ -z "$BASE_WORKLOAD_ID" ] && \
	git rev-parse --verify --quiet "$WORKLOAD_BRIDGE_RUNTIME_REF" >/dev/null && \
	git rev-parse --verify --quiet "$WORKLOAD_BRIDGE_SWITCH_REF" >/dev/null; then
	BRIDGE_RUNTIME_SHA="$(git rev-parse "$WORKLOAD_BRIDGE_RUNTIME_REF")"
	BRIDGE_SWITCH_SHA="$(git rev-parse "$WORKLOAD_BRIDGE_SWITCH_REF")"
	if git merge-base --is-ancestor "$BASE_SHA" "$BRIDGE_RUNTIME_SHA" && \
		git merge-base --is-ancestor "$BRIDGE_SWITCH_SHA" "$HEAD_SHA"; then
		echo "[bench] bridging legacy workload through runtime: $BRIDGE_RUNTIME_SHA"
		git worktree add --detach "$BRIDGE_DIR" "$BRIDGE_RUNTIME_SHA" >/dev/null
		run_bench "bridge legacy workload" "$BRIDGE_DIR" "$BRIDGE_LEGACY_RESULT_DIR"

		# Use the migration's v2 harness, which supports this historical runtime's ABI.
		# HEAD may use a newer plugin ABI even when its benchmark workload is unchanged.
		# The head report still validates the bridged workload identity and scenario.
		git archive "$BRIDGE_SWITCH_SHA" \
			packages/core/bench/pluginLifecycle.bench.ts packages/core/bench/pluginLifecycle | \
			tar -x -C "$BRIDGE_DIR"
		run_bench "bridge current workload" "$BRIDGE_DIR" "$BRIDGE_CURRENT_RESULT_DIR"

		node "$ROOT/scripts/core-bench-reference-bridge.mjs" \
			"$REFERENCE_REPORT" \
			"$BRIDGE_LEGACY_RESULT_DIR/plugin-lifecycle.json" \
			"$BRIDGE_CURRENT_RESULT_DIR/plugin-lifecycle.json" \
			"$BRIDGED_REFERENCE_REPORT"
		REFERENCE_FOR_HEAD="$BRIDGED_REFERENCE_REPORT"
		echo "[bench] bridged reference: $BRIDGED_REFERENCE_REPORT"
	fi
fi

run_bench "head" "$HEAD_DIR" "$HEAD_RESULT_DIR" "$REFERENCE_FOR_HEAD"

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
