#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const localProjectsRoot = resolve(repositoryRoot, 'local-projects')
const { consumerRoot, sourceArgs } = parseArguments(process.argv.slice(2))

const relativeConsumer = relative(localProjectsRoot, consumerRoot)
if (
	relativeConsumer === '' ||
	relativeConsumer === '..' ||
	relativeConsumer.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
) {
	fail(`Consumer must be inside ${localProjectsRoot}: ${consumerRoot}`)
}

if (!existsSync(resolve(consumerRoot, 'pluxel.sources.jsonc'))) {
	if (sourceArgs.length > 0) {
		fail(
			`Source install options require pluxel.sources.jsonc: ${consumerRoot}\n` +
				'Run the launcher without source-specific options for a registry-managed project.',
		)
	}
	console.log(`→ Installing registry-managed local project ${relativeConsumer}`)
	run('pnpm', ['install'], consumerRoot)
	process.exit(0)
}

ensureWorkspaceCli()

// This launcher intentionally selects the checkouts colocated in this Pluxel development tree.
// Registering them here makes a fresh local-project checkout independent from global PATH state.
registerCheckout(repositoryRoot)
for (const entry of readdirSync(localProjectsRoot, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue
	const checkout = resolve(localProjectsRoot, entry.name)
	if (!existsSync(resolve(checkout, 'package.json'))) continue
	if (!hasGitOrigin(checkout)) continue
	registerCheckout(checkout)
}

run(
	process.execPath,
	[
		resolve(repositoryRoot, 'packages/cli/dist/cli.mjs'),
		'source',
		'install',
		'--root',
		consumerRoot,
		...sourceArgs,
	],
	repositoryRoot,
)

function parseArguments(args) {
	if (args.includes('--help') || args.includes('-h')) {
		console.log(`Usage:
  node scripts/source-local-project.mjs <local-project> [source-install-options]
  node ../../scripts/source-local-project.mjs [source-install-options]

When run inside local-projects/<name>, the current directory is the default project.
Examples:
  node scripts/source-local-project.mjs local-projects/chatbot
  node ../../scripts/source-local-project.mjs --no-build`)
		process.exit(0)
	}

	const project = args[0] && !args[0].startsWith('-') ? args[0] : undefined
	const forwardedArgs = project ? args.slice(1) : args
	const root = resolve(project ? repositoryRoot : process.cwd(), project ?? '.')
	return { consumerRoot: root, sourceArgs: forwardedArgs }
}

function ensureWorkspaceCli() {
	const cli = resolve(repositoryRoot, 'packages/cli/dist/cli.mjs')
	if (existsSync(cli)) return

	console.log('→ Preparing the Pluxel workspace CLI')
	run('corepack', ['pnpm', '--dir', repositoryRoot, 'install', '--frozen-lockfile'], repositoryRoot)
	run(
		'corepack',
		['pnpm', '--dir', repositoryRoot, '--filter', '@pluxel/cli', 'build'],
		repositoryRoot,
	)
	if (!existsSync(cli)) fail(`CLI build did not produce ${cli}`)
}

function registerCheckout(checkout) {
	run(
		process.execPath,
		[resolve(repositoryRoot, 'packages/cli/dist/cli.mjs'), 'source', 'register', checkout],
		repositoryRoot,
	)
}

function hasGitOrigin(checkout) {
	return (
		spawnSync('git', ['-C', checkout, 'remote', 'get-url', 'origin'], {
			stdio: 'ignore',
		}).status === 0
	)
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
	if (result.error) fail(`${command}: ${result.error.message}`)
	if (result.status !== 0) process.exit(result.status ?? 1)
}

function fail(message) {
	console.error(`[pluxel local source] ${message}`)
	process.exit(1)
}
