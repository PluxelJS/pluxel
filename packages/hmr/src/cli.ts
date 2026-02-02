#!/usr/bin/env node
import { resolve } from 'node:path'
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
		else if (a === '--help' || a === '-h') return { command: 'help', rootDir, configPath, snapshotStdin }
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

function assertSnapshotShape(snapshot: any): asserts snapshot is WorkspaceSnapshot {
	if (!snapshot || typeof snapshot !== 'object') throw new Error('Invalid snapshot: expected object')
	if (!Array.isArray(snapshot.enabledEntries)) throw new Error('Invalid snapshot: enabledEntries missing')
	if (!Array.isArray(snapshot.watchRoots)) throw new Error('Invalid snapshot: watchRoots missing')
	if (!Array.isArray(snapshot.includeGlobs)) throw new Error('Invalid snapshot: includeGlobs missing')
	if (!Array.isArray(snapshot.excludeGlobs)) throw new Error('Invalid snapshot: excludeGlobs missing')
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
		roots: snapshot.watchRoots,
		include: snapshot.includeGlobs,
		exclude: snapshot.excludeGlobs,
		entries: snapshot.enabledEntries,
	})
}

void main().catch((error) => {
	const msg = error instanceof Error ? error.message : String(error)
	process.stderr.write(`${msg}\n`)
	process.exitCode = 1
})
