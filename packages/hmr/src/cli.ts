#!/usr/bin/env node
import { resolve } from 'pathe'
import { stdin } from 'node:process'
import { diagnoseWorkspace, type WorkspaceSnapshot } from '@pluxel/cli/hmr'
import { startHmrHost } from './host'

type Args = {
	command: 'start' | 'doctor' | 'help'
	rootDir: string
	configPath: string
	snapshotStdin: boolean
}

function parseArgs(argv: string[]): Args {
	const commandRaw = argv[0]
	const command =
		commandRaw === 'start' || commandRaw === 'doctor' || commandRaw === 'help'
			? commandRaw
			: 'start'

	let rootDir = process.cwd()
	let configPath = 'pluxel.hmr.jsonc'
	let snapshotStdin = false

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--root') rootDir = argv[++i] ?? rootDir
		else if (a === '--config') configPath = argv[++i] ?? configPath
		else if (a === '--snapshot-stdin') snapshotStdin = true
		else if (a === '--help' || a === '-h')
			return { command: 'help', rootDir, configPath, snapshotStdin }
	}

	return {
		command,
		rootDir: resolve(rootDir),
		configPath: resolve(rootDir, configPath),
		snapshotStdin,
	}
}

function printHelp() {
	const msg = [
		'pluxel-hmr',
		'',
		'Usage:',
		'  pluxel-hmr start [--root <dir>] [--config <file>] [--snapshot-stdin]',
		'  pluxel-hmr doctor [--root <dir>] [--config <file>]',
		'',
		'Notes:',
		'  - When --snapshot-stdin is provided, pluxel-hmr reads a WorkspaceSnapshot JSON from stdin and skips discovery.',
		'  - Without --snapshot-stdin, pluxel-hmr reads pluxel.hmr.jsonc and runs discovery via @pluxel/cli/hmr.',
	].join('\n')
	process.stdout.write(`${msg}\n`)
}

async function readStdin(): Promise<string> {
	return await new Promise((resolvePromise, reject) => {
		let out = ''
		stdin.setEncoding('utf8')
		stdin.on('data', (chunk) => {
			out += chunk
		})
		stdin.on('end', () => resolvePromise(out))
		stdin.on('error', reject)
	})
}

function assertSnapshotShape(snapshot: unknown): asserts snapshot is WorkspaceSnapshot {
	if (!snapshot || typeof snapshot !== 'object')
		throw new Error('Invalid snapshot: expected object')
	const s = snapshot as Record<string, unknown>
	if (!Array.isArray(s.enabledEntries)) throw new Error('Invalid snapshot: enabledEntries missing')
	if (!Array.isArray(s.watchRoots)) throw new Error('Invalid snapshot: watchRoots missing')
	if (!Array.isArray(s.includeGlobs)) throw new Error('Invalid snapshot: includeGlobs missing')
	if (!Array.isArray(s.excludeGlobs)) throw new Error('Invalid snapshot: excludeGlobs missing')
	if (s.builtinPackages !== undefined) {
		if (
			!Array.isArray(s.builtinPackages) ||
			(s.builtinPackages as unknown[]).some((x) => typeof x !== 'string')
		) {
			throw new Error('Invalid snapshot: builtinPackages must be string[]')
		}
	}
	if (s.builtinsFromDist !== undefined) {
		if (!Array.isArray(s.builtinsFromDist))
			throw new Error('Invalid snapshot: builtinsFromDist must be array')
		for (const raw of s.builtinsFromDist as unknown[]) {
			if (!raw || typeof raw !== 'object' || Array.isArray(raw))
				throw new Error('Invalid snapshot: builtinsFromDist[] must be object')
			const o = raw as Record<string, unknown>
			if (typeof o.packageName !== 'string' || typeof o.entry !== 'string')
				throw new Error('Invalid snapshot: builtinsFromDist[] must have packageName/entry strings')
		}
	}
}

async function resolveSnapshot(args: Args): Promise<WorkspaceSnapshot> {
	if (args.snapshotStdin) {
		const raw = await readStdin()
		const parsed = JSON.parse(raw)
		assertSnapshotShape(parsed)
		return parsed
	}
	const res = await diagnoseWorkspace({
		rootDir: args.rootDir,
		configPath: args.configPath,
		env: process.env,
	})
	if (!res.ok) throw new Error(res.errors.join('\n'))
	return res.snapshot
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.command === 'help') {
		printHelp()
		return
	}

	if (args.command === 'doctor') {
		const res = await diagnoseWorkspace({
			rootDir: args.rootDir,
			configPath: args.configPath,
			env: process.env,
		})
		if (!res.ok) {
			process.stderr.write(`${res.errors.join('\n')}\n`)
			process.exitCode = 1
			return
		}
		const s = res.snapshot
		const out = {
			activeProfile: s.activeProfile,
			roots: s.roots,
			enabled: s.enabled,
			discovered: s.discovered.map((p) => ({ name: p.name, entry: p.entry })),
			includedEntries: s.includedEntries,
			watchRoots: s.watchRoots,
			warnings: res.warnings,
		}
		process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
		return
	}

	// start
	const snapshot = await resolveSnapshot(args)

	await startHmrHost({
		root: args.rootDir,
		chdir: true,
		workspaceSnapshot: snapshot,
	})
}

void main().catch((error) => {
	const msg = error instanceof Error ? error.message : String(error)
	process.stderr.write(`${msg}\n`)
	process.exitCode = 1
	// Force exit: Vite may leave open handles (watchers/servers) after startup failures.
	// This is a CLI entrypoint, so a hard exit is preferable to hanging indefinitely.
	setTimeout(() => process.exit(1), 200).unref()
})
