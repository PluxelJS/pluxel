#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { stdin } from 'node:process'
import { diagnoseWorkspace, type WorkspaceSnapshot } from '@pluxel/cli/hmr'
import { type CommitSummary, checkPluginDecorator, type PluginService } from '@pluxel/core'
import { isAbsolute, join, resolve } from 'pathe'
import { logsLatestText } from './api/usecases/logsLlm'
import { startHmrHost } from './host'
import type { LlmLogFormatOptions } from './logger/llm'
import { runtimeLogStores } from './logger/store'

const DEFAULT_CONFIG = 'pluxel.hmr.jsonc'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_QUIET_MS = 500

type Args = {
	command: 'start' | 'doctor' | 'agent' | 'help'
	rootDir: string
	configPath: string
	snapshotStdin: boolean
	logsDir?: string
	logFile?: string
	llmLogFile?: string
	llmOptions?: LlmLogFormatOptions
	quietMs: number
	timeoutMs: number
	noFileLog: boolean
	clean: boolean
	json: boolean
}

function parseArgs(argv: string[]): Args {
	const commandRaw = argv[0]
	const command =
		commandRaw === 'start' ||
		commandRaw === 'doctor' ||
		commandRaw === 'agent' ||
		commandRaw === 'help'
			? commandRaw
			: 'start'

	let rootDir = process.cwd()
	let configPath = DEFAULT_CONFIG
	let snapshotStdin = false
	let logsDir: string | undefined
	let logFile: string | undefined
	let llmLogFile: string | undefined
	const llmOptions: LlmLogFormatOptions = {}
	let quietMs = command === 'agent' ? 0 : DEFAULT_QUIET_MS
	let timeoutMs = DEFAULT_TIMEOUT_MS
	let noFileLog = command === 'agent'
	let clean = false
	let json = false

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--root') rootDir = argv[++i] ?? rootDir
		else if (a === '--config') configPath = argv[++i] ?? configPath
		else if (a === '--snapshot-stdin') snapshotStdin = true
		else if (a === '--logs-dir') logsDir = argv[++i] ?? logsDir
		else if (a === '--log-file') {
			logFile = argv[++i] ?? logFile
			noFileLog = false
		} else if (a === '--file-log') noFileLog = false
		else if (a === '--llm-log') llmLogFile = argv[++i] ?? llmLogFile
		else if (a === '--llm-max-chars') llmOptions.maxChars = Number(argv[++i])
		else if (a === '--llm-max-line-chars') llmOptions.maxLineChars = Number(argv[++i])
		else if (a === '--llm-max-stack-lines') llmOptions.maxStackLines = Number(argv[++i])
		else if (a === '--no-file-log') noFileLog = true
		else if (a === '--quiet-ms') quietMs = Number(argv[++i])
		else if (a === '--timeout-ms') timeoutMs = Number(argv[++i])
		else if (a === '--clean') clean = true
		else if (a === '--json') json = true
		else if (a === '--help' || a === '-h') {
			return {
				command: 'help',
				rootDir,
				configPath,
				snapshotStdin,
				logsDir,
				logFile,
				llmLogFile,
				llmOptions,
				quietMs,
				timeoutMs,
				noFileLog,
				clean,
				json,
			}
		}
	}

	return {
		command,
		rootDir: resolve(rootDir),
		configPath: resolve(rootDir, configPath),
		snapshotStdin,
		logsDir: logsDir ? resolve(rootDir, logsDir) : undefined,
		logFile,
		llmLogFile,
		llmOptions,
		quietMs: Number.isFinite(quietMs)
			? Math.max(0, Math.floor(quietMs))
			: command === 'agent'
				? 0
				: DEFAULT_QUIET_MS,
		timeoutMs: Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : DEFAULT_TIMEOUT_MS,
		noFileLog,
		clean,
		json,
	}
}

function printHelp() {
	const msg = [
		'pluxel-hmr',
		'',
		'Usage:',
		'  pluxel-hmr start [--root <dir>] [--config <file>] [--snapshot-stdin]',
		'  pluxel-hmr doctor [--root <dir>] [--config <file>]',
		'  pluxel-hmr agent [--root <dir>] [--config <file>] [--snapshot-stdin] [--json]',
		'                  [--logs-dir <dir>] [--llm-log <file>] [--file-log] [--log-file <file>]',
		'                  [--quiet-ms <ms>] [--timeout-ms <ms>]',
		'                  [--llm-max-chars <n>] [--llm-max-line-chars <n>] [--llm-max-stack-lines <n>]',
		'                  [--no-file-log] [--clean]',
		'',
		'Notes:',
		'  - When --snapshot-stdin is provided, pluxel-hmr reads a WorkspaceSnapshot JSON from stdin and skips discovery.',
		`  - Without --snapshot-stdin, pluxel-hmr reads ${DEFAULT_CONFIG} and runs discovery via @pluxel/cli/hmr.`,
		'  - agent: cold-start (warmup), drain queued batches (state-based), export LLM-friendly logs, then shutdown and exit.',
		'           Pass --quiet-ms to additionally wait for a quiet window (time-based).',
		'           --timeout-ms is a deadlock safeguard for idle/shutdown (and stable wait when enabled).',
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
		if (!Array.isArray(s.builtinPackages) || s.builtinPackages.some((x) => typeof x !== 'string')) {
			throw new Error('Invalid snapshot: builtinPackages must be string[]')
		}
	}
	if (s.builtinsFromDist !== undefined) {
		if (!Array.isArray(s.builtinsFromDist))
			throw new Error('Invalid snapshot: builtinsFromDist must be array')
		for (const raw of s.builtinsFromDist) {
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

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			cause: error.cause,
		}
	}
	return { name: 'Error', message: String(error) }
}

function resolveLogsDir(args: Args) {
	return args.logsDir ?? resolve(args.rootDir, 'logs')
}

function resolveInDir(dir: string, maybeRelativeOrAbs: string) {
	return isAbsolute(maybeRelativeOrAbs) ? maybeRelativeOrAbs : resolve(dir, maybeRelativeOrAbs)
}

async function safeRm(path: string) {
	await rm(path, { force: true }).catch(() => undefined)
}

function summarizeCommit(commit: CommitSummary | undefined) {
	if (!commit) return null
	return {
		added: commit.added.map(String),
		replaced: commit.replaced.map(String),
		removed: commit.removed.map(String),
		failed: commit.failed.map(String),
		touched: commit.touched.map(String),
	}
}

async function raceTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<{ ok: true; value: T; timedOut: false } | { ok: false; timedOut: true }> {
	const ms =
		typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
			? Math.max(0, Math.floor(timeoutMs))
			: 0
	if (ms <= 0) return { ok: true, value: await promise, timedOut: false }

	let t: NodeJS.Timeout | null = null
	try {
		type RaceWinner = { type: 'value'; value: T } | { type: 'timeout' }
		const winner = await Promise.race([
			promise.then((value): RaceWinner => ({ type: 'value', value })),
			new Promise<RaceWinner>((resolve) => {
				t = setTimeout(() => resolve({ type: 'timeout' }), ms)
			}),
		])
		if (winner.type === 'timeout') return { ok: false, timedOut: true }
		return { ok: true, value: winner.value, timedOut: false }
	} finally {
		if (t) clearTimeout(t)
	}
}

async function tryWaitForStableOrNoBatches(params: {
	ctx: Awaited<ReturnType<typeof startHmrHost>>['ctx']
	timeoutMs: number
	quietMs: number
}) {
	const hmr = params.ctx.root.hmrService
	const lastEpoch = hmr.api.lastBatch()?.epoch ?? 0
	// `waitForStable()` needs to "observe" a batch first; make the current batch eligible for immediate return.
	const afterEpoch = Math.max(0, lastEpoch - 1)
	try {
		return await hmr.api.waitForStable({
			afterEpoch,
			timeoutMs: params.timeoutMs,
			quietMs: params.quietMs,
		})
	} catch (error) {
		if (error instanceof Error && error.name === 'HmrBatchTimeoutError') return null
		throw error
	}
}

function listRegisteredPluginCtors(registry: PluginService) {
	const keys = Array.from(registry.container!.services.keys())
	return keys.filter((k): k is new (...args: never[]) => unknown => {
		if (typeof k !== 'function') return false
		return checkPluginDecorator(k)
	})
}

async function shutdownAllPlugins(registry: PluginService) {
	const plugins = listRegisteredPluginCtors(registry)

	registry.resetDraft()

	for (const key of plugins) {
		// Keep commits valid: default unregister behavior cascades to dependents.
		registry.unregister(key)
	}
	await registry.commit()
	registry.resetDraft()
}

async function exportLlmLogs(params: {
	logsDir: string
	llmLogFile?: string
	llmOptions?: LlmLogFormatOptions
}) {
	const formatted = logsLatestText({
		streamId: 'default',
		limit: 20_000,
		format: params.llmOptions,
	})
	const outFile = params.llmLogFile
		? resolveInDir(params.logsDir, params.llmLogFile)
		: join(params.logsDir, 'hmr.llm.txt')

	await writeFile(outFile, formatted.text ? `${formatted.text}\n` : '', 'utf8')
	return { outFile, formatted }
}

function forceExit(code: number) {
	process.exitCode = code
	setTimeout(() => process.exit(code), 200).unref()
}

async function runDoctor(args: Args) {
	const res = await diagnoseWorkspace({
		rootDir: args.rootDir,
		configPath: args.configPath,
		env: process.env,
	})
	if (!res.ok) {
		process.stderr.write(`${res.errors.join('\n')}\n`)
		forceExit(1)
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
}

async function runAgent(args: Args) {
	const snapshot = await resolveSnapshot(args)

	const logsDir = resolveLogsDir(args)
	await mkdir(logsDir, { recursive: true })

	if (args.clean) {
		// Reset in-memory runtime logs so the LLM export is deterministic for this run.
		runtimeLogStores.getOrCreate('default').reset()
		await safeRm(join(logsDir, 'hmr.llm.txt'))
		await safeRm(join(logsDir, 'hmr.agent.summary.json'))
		await safeRm(resolveInDir(logsDir, args.logFile ?? 'hmr.agent.log'))
		if (args.llmLogFile) await safeRm(resolveInDir(logsDir, args.llmLogFile))
	}

	let res: Awaited<ReturnType<typeof startHmrHost>> | null = null
	let warmupError: unknown = null
	let agentError: unknown = null
	let stable: unknown = null
	let idleTimedOut = false
	let stableTimedOut = false
	let shutdownTimedOut = false

	try {
		const fileLog = args.noFileLog ? false : resolveInDir(logsDir, args.logFile ?? 'hmr.agent.log')

		res = await startHmrHost({
			root: args.rootDir,
			chdir: true,
			workspaceSnapshot: snapshot,
			logsDir,
			// Avoid writing runtime state into git-tracked `data/` folders during agent runs.
			// Template repos typically ignore `.pluxel/`.
			store: {
				configFile: '.pluxel/hmr/config.{profile}.json',
				pluginDataDir: '.pluxel/plugin-data',
			},
			printUrls: false,
			warmup: false,
			logging: {
				preset: 'hmr',
				console: false,
				file: fileLog,
				// Agent runs want deterministic "no buffered logs"; flush immediately.
				ui: { minLevel: 'info', bufferSize: 1, flushIntervalMs: 0 },
				debug: [],
			},
		})

		try {
			await res.ctx.root.hmrService.warmup({ bestEffort: false })
		} catch (error) {
			warmupError = error
		}

		// Drain any queued/scheduled batch flushes before shutdown. This is state-based
		// (not time-based); timeout is only a deadlock safeguard.
		try {
			await res.ctx.root.hmrService.api.waitForIdle({ timeoutMs: args.timeoutMs })
		} catch (error) {
			idleTimedOut = true
			void error
		}

		// Optional: if caller asks for a quiet window, wait for "no newer batches for quietMs".
		// This is inherently time-based and should remain opt-in.
		if (args.quietMs > 0 && res.ctx.root.hmrService.api.lastBatch()) {
			stable = await tryWaitForStableOrNoBatches({
				ctx: res.ctx,
				timeoutMs: args.timeoutMs,
				quietMs: args.quietMs,
			})
			stableTimedOut = stable === null
		}

		// Best-effort shutdown: do not let plugin cleanup hang agent runs.
		const shutdownRes = await raceTimeout(
			(async () => {
				await shutdownAllPlugins(res.ctx.registry)
				await res.ctx.effects.dispose()
			})(),
			args.timeoutMs,
		)
		shutdownTimedOut = !shutdownRes.ok
	} catch (error) {
		agentError = error
	}

	const exportRes = await exportLlmLogs({
		logsDir,
		llmLogFile: args.llmLogFile,
		llmOptions: args.llmOptions,
	})

	const summary = {
		ok: !warmupError && !agentError && !idleTimedOut && !stableTimedOut && !shutdownTimedOut,
		rootDir: args.rootDir,
		configPath: args.configPath,
		logsDir,
		llmLog: exportRes.outFile,
		llmLogLines: exportRes.formatted.count,
		llmLogTruncated: exportRes.formatted.truncated,
		stableBatch: stable,
		idleTimedOut,
		stableTimedOut,
		shutdownTimedOut,
		lastCommit: summarizeCommit(res?.ctx.registry.lastCommit),
		warmupError: warmupError ? serializeError(warmupError) : null,
		agentError: agentError ? serializeError(agentError) : null,
	}

	const summaryFile = join(logsDir, 'hmr.agent.summary.json')
	await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

	if (args.json) {
		process.stdout.write(`${JSON.stringify({ ...summary, summaryFile }, null, 2)}\n`)
	} else {
		process.stdout.write(`${summaryFile}\n${exportRes.outFile}\n`)
	}

	forceExit(summary.ok ? 0 : 1)
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	if (args.command === 'help') {
		printHelp()
		return
	}

	if (args.command === 'doctor') {
		await runDoctor(args)
		return
	}

	if (args.command === 'agent') {
		await runAgent(args)
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
	// Force exit: Vite may leave open handles (watchers/servers) after startup failures.
	// This is a CLI entrypoint, so a hard exit is preferable to hanging indefinitely.
	forceExit(1)
})
