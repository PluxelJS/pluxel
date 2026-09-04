#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const developmentRoot = dirname(repositoryRoot)
const localProjectsRoot = resolve(repositoryRoot, 'local-projects')
const sourceCheckoutsRoot = resolve(developmentRoot, 'source-checkouts')
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

// This launcher intentionally selects the source providers colocated in this development tree.
// A full source checkout wins over a local-project consumer mirror with the same Git identity;
// otherwise a partial consumer can overwrite the provider and make its own overlay recursive.
const registeredRepositories = new Set()
registerCheckout(repositoryRoot)
for (const checkout of childGitCheckouts(sourceCheckoutsRoot)) registerCheckout(checkout)
for (const entry of readdirSync(localProjectsRoot, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue
	const checkout = resolve(localProjectsRoot, entry.name)
	if (checkout === consumerRoot) continue
	if (!existsSync(resolve(checkout, 'package.json'))) continue
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
	const repository = checkoutRepository(checkout)
	if (!repository || registeredRepositories.has(repository)) return
	run(
		process.execPath,
		[resolve(repositoryRoot, 'packages/cli/dist/cli.mjs'), 'source', 'register', checkout],
		repositoryRoot,
	)
	registeredRepositories.add(repository)
}

function childGitCheckouts(root) {
	if (!existsSync(root)) return []
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => resolve(root, entry.name))
}

function checkoutRepository(checkout) {
	const result = spawnSync('git', ['-C', checkout, 'remote', 'get-url', 'origin'], {
		encoding: 'utf8',
	})
	if (result.status !== 0 || !result.stdout.trim()) return undefined
	return normalizeRepositoryIdentity(result.stdout.trim())
}

// Keep this small bootstrap script independent from the CLI source modules it may need to build.
function normalizeRepositoryIdentity(input) {
	let value = input.trim().replace(/^git\+/, '')
	const scp = value.includes('://') ? undefined : value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
	if (scp && !/^[A-Za-z]:[\\/]/.test(value)) value = `https://${scp[1]}/${scp[2]}`
	if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value.replace(/^\/+/, '')}`
	const url = new URL(value)
	const path = url.pathname
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '')
		.replace(/^\/+/, '')
	return `https://${url.host.toLowerCase()}/${path}`
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
