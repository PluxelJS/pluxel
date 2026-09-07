#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'USAGE'
Usage: bash bootstrap-source-dev.sh [options]

Clone Pluxel, chatbot and an app, then prepare the app for Git source development.
Requires Git, Node.js >=24, pnpm 11 and Corepack on PATH.

  --dir PATH       Parent of the pluxel checkout (default: $HOME/code/pluxel-dev)
  --app-repo URL   App to clone (default: https://github.com/PluxelJS/bot-new-omni.git)
  --app-dir PATH   Existing app checkout, or destination for --app-repo
                   (default: <pluxel>/local-projects/bot-new-omni)
  --start          Run pnpm dev in the app after preparation
  -h, --help       Show help

Existing checkouts are reused without pulling or switching revisions. The script
registers chatbot, installs dependencies and builds required source artifacts.
Pluxel is discovered from its CLI entry; no global CLI installation is needed.
USAGE
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

base_dir="${HOME}/code/pluxel-dev"
app_repo='https://github.com/PluxelJS/bot-new-omni.git'
app_dir=''
start=false
while (($#)); do
	case "$1" in
		--dir|--app-repo|--app-dir)
			(($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || fail "$1 requires a value"
			case "$1" in
				--dir) base_dir=$2 ;;
				--app-repo) app_repo=$2 ;;
				--app-dir) app_dir=$2 ;;
			esac
			shift 2 ;;
		--start) start=true; shift ;;
		-h|--help) usage; exit 0 ;;
		*) fail "Unknown argument: $1 (see --help)" ;;
	esac
done

for command in git node pnpm corepack; do
	command -v "$command" >/dev/null 2>&1 || fail "Install $command and put it on PATH first (see docs/development/source-bootstrap.md)."
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || fail 'Node.js >=24 is required.'
pnpm_version=$(pnpm --version)
[[ "$pnpm_version" == 11.* ]] || fail "pnpm 11 is required; found $pnpm_version."

mkdir -p -- "$base_dir"
base_dir=$(cd -- "$base_dir" && pwd -P)
pluxel_dir="$base_dir/pluxel"
chatbot_dir="$pluxel_dir/local-projects/chatbot"
app_dir=${app_dir:-"$pluxel_dir/local-projects/bot-new-omni"}
# Resolve before changing directories so caller-relative --app-dir remains meaningful.
if [[ "$app_dir" != /* ]]; then app_dir="$PWD/$app_dir"; fi

checkout() {
	local repo=$1 destination=$2 root submodules
	if [[ ! -e "$destination" ]]; then
		mkdir -p -- "$(dirname -- "$destination")"
		git clone --recurse-submodules -- "$repo" "$destination"
	else
		root=$(git -C "$destination" rev-parse --show-toplevel) || fail "Not a Git checkout: $destination"
		[[ "$(cd -- "$destination" && pwd -P)" == "$(cd -- "$root" && pwd -P)" ]] || fail "Not a Git checkout root: $destination"
		printf 'Reusing checkout: %s\n' "$destination"
	fi
	# Do not reset an existing submodule's revision or worktree on repeated runs.
	submodules=$(git -C "$destination" submodule status --recursive)
	if [[ "$submodules" == -* || "$submodules" == *$'\n-'* ]]; then
		printf 'Initialize missing submodules, then rerun:\n  git -C %q submodule update --init --recursive\n' "$destination" >&2
		exit 1
	fi
}

checkout 'https://github.com/PluxelJS/pluxel.git' "$pluxel_dir"
checkout 'https://github.com/PluxelJS/chatbot.git' "$chatbot_dir"
checkout "$app_repo" "$app_dir"
app_dir=$(cd -- "$app_dir" && pwd -P)
[[ -f "$app_dir/pluxel.sources.jsonc" ]] || fail "App must declare its Git sources in $app_dir/pluxel.sources.jsonc (see source-workspaces.md)."
cli="$pluxel_dir/packages/cli/bin/pluxel.mjs"
[[ -f "$cli" ]] || fail "Pluxel CLI entry is missing: $cli"

(
	cd -- "$pluxel_dir"
	pnpm install
	pnpm --filter @pluxel/cli build
)
(
	cd -- "$app_dir"
	node "$cli" source register "$chatbot_dir"
	node "$cli" source list
	node "$cli" source install
	node "$cli" source doctor
)

printf '\nSource development is ready. Start the app with:\n  cd %q\n  pnpm dev\n' "$app_dir"
printf '\nbot-new-omni: pnpm dev requires running Docker with Compose v2; it starts\nInngest, VictoriaMetrics and VictoriaLogs, then the Host via Portless. No .env\nis needed for the default local Host. Configure KOOK accounts separately.\n'
if "$start"; then
	cd -- "$app_dir"
	exec pnpm dev
fi
