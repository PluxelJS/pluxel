import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { type ArgValues, define } from 'gunshi'
import { resolve } from 'pathe'
import {
	DEFAULT_HMR_CONFIG_BASENAME,
	type PluxelHmrConfigV1,
	readHmrConfigV1,
	writeHmrConfigV1,
} from '../hmr/config'
import { diagnoseWorkspace } from '../hmr/diagnose'
import { writeHmrDiscoveredIndex } from '../hmr/discovered-index'
import { uniqPreserveOrder } from '../hmr/utils'

const hmrCommandArgs = {
	root: {
		type: 'string',
		description: 'Workspace root',
		default: '.',
	},
	config: {
		type: 'string',
		description: `Config file path (default: ${DEFAULT_HMR_CONFIG_BASENAME})`,
		default: DEFAULT_HMR_CONFIG_BASENAME,
	},
	profile: {
		type: 'string',
		description: 'Profile name (overrides config.profile for this run)',
	},
	startCmd: {
		type: 'string',
		description:
			'Custom start command (runs in --root). When provided, replaces the default pluxel-hmr snapshot start.',
	},
	// Alias for shell-friendly flag style.
	'start-cmd': {
		type: 'string',
		description: 'Alias for --startCmd',
	},
	builtinSet: {
		type: 'string',
		description:
			'For `pluxel hmr builtin`: non-interactive builtin package list (comma or newline separated). When provided, writes config.',
	},
	// Alias for shell-friendly flag style.
	'builtin-set': {
		type: 'string',
		description: 'Alias for --builtinSet',
	},
	enabledSet: {
		type: 'string',
		description:
			'For `pluxel hmr enabled`: non-interactive profile package list (comma or newline separated). When provided, writes config.',
	},
	// Alias for shell-friendly flag style.
	'enabled-set': {
		type: 'string',
		description: 'Alias for --enabledSet',
	},
} as const

type HmrArgs = typeof hmrCommandArgs
type HmrValues = ArgValues<HmrArgs> & {
	'start-cmd'?: string
	'builtin-set'?: string
	'enabled-set'?: string
}

type HmrProfile = PluxelHmrConfigV1['profiles'][string]

function normalizePositionals(name: string | undefined, positionals: unknown) {
	if (!Array.isArray(positionals)) return []
	const list = positionals.map((v) => (v == null ? '' : String(v))).filter(Boolean)
	if (list.length && name && list[0] === name) return list.slice(1)
	return list
}

function splitList(raw: string): string[] {
	return raw
		.split(/[\n,]/g)
		.map((s) => s.trim())
		.filter(Boolean)
}

function parseEnvList(raw: string | undefined): string[] {
	if (!raw) return []
	return splitList(raw)
}

function ensureProfile(cfg: ReturnType<typeof readHmrConfigV1>, name: string) {
	if (!cfg.profiles[name]) cfg.profiles[name] = { enabled: [] }
}

function resolvePluxelHmrBin(rootDir: string) {
	const base = resolve(rootDir, 'node_modules', '.bin')
	const candidates =
		process.platform === 'win32'
			? [
					resolve(base, 'pluxel-hmr.cmd'),
					resolve(base, 'pluxel-hmr.exe'),
					resolve(base, 'pluxel-hmr'),
				]
			: [resolve(base, 'pluxel-hmr')]
	for (const p of candidates) if (existsSync(p)) return p

	// Monorepo fallback: allow running without installing @pluxel/hmr at workspace root.
	const repoBin = resolve(rootDir, 'packages/hmr/bin/pluxel-hmr.mjs')
	if (existsSync(repoBin)) return repoBin

	return 'pluxel-hmr'
}

async function spawnPluxelHmrStart(rootDir: string, snapshotJson: string) {
	const bin = resolvePluxelHmrBin(rootDir)
	const isNodeScript = bin.endsWith('pluxel-hmr.mjs')
	const cmd = isNodeScript ? process.execPath : bin
	const args = isNodeScript ? [bin, 'start', '--snapshot-stdin'] : ['start', '--snapshot-stdin']
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(cmd, args, {
			cwd: rootDir,
			stdio: ['pipe', 'inherit', 'inherit'],
			shell: process.platform === 'win32',
		})
		child.on('error', reject)
		child.on('exit', (code, signal) => {
			if (code === 0) return resolvePromise()
			// Treat SIGINT/SIGTERM as a normal cancellation (Ctrl+C / `timeout`).
			if (code === null && (signal === 'SIGINT' || signal === 'SIGTERM')) return resolvePromise()
			const extra = signal ? `signal ${signal}` : `exit ${code ?? 'null'}`
			reject(new Error(`${bin} start failed (${extra})`))
		})
		child.stdin?.write(snapshotJson)
		child.stdin?.end()
	})
}

async function spawnStartCommand(params: {
	rootDir: string
	command: string
	env: Record<string, string | undefined>
}) {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(params.command, [], {
			cwd: params.rootDir,
			stdio: 'inherit',
			shell: true,
			env: { ...process.env, ...params.env },
		})
		child.on('error', reject)
		child.on('exit', (code, signal) => {
			if (code === 0) return resolvePromise()
			if (code === null && (signal === 'SIGINT' || signal === 'SIGTERM')) return resolvePromise()
			const extra = signal ? `signal ${signal}` : `exit ${code ?? 'null'}`
			reject(new Error(`start command failed (${extra})`))
		})
	})
}

function formatList(items: string[], max = 60) {
	if (items.length <= max) return items.join('\n')
	const head = items.slice(0, max)
	return `${head.join('\n')}\n... (${items.length - max} more)`
}

function printHeading(title: string) {
	process.stdout.write(`\n${title}\n${'-'.repeat(Math.min(Math.max(title.length, 8), 64))}\n`)
}

function resolveActiveProfile(params: {
	cfg: ReturnType<typeof readHmrConfigV1>
	valuesProfile?: string
	envProfile?: string
}) {
	return params.valuesProfile ?? params.envProfile ?? params.cfg.profile
}

async function runTui(params: {
	rootDir: string
	configPath: string
	env: Record<string, string | undefined>
	skipPackages: Set<string>
	initialTab?: Parameters<typeof import('../tui/hmr-prompt').runHmrPromptTui>[0]['initialTab']
	initialOpen?: Parameters<typeof import('../tui/hmr-prompt').runHmrPromptTui>[0]['initialOpen']
	startCmd?: string | undefined
}) {
	const { runHmrPromptTui } = await import('../tui/hmr-prompt')
	const res = await runHmrPromptTui({
		rootDir: params.rootDir,
		configPath: params.configPath,
		env: params.env,
		skipPackages: params.skipPackages,
		initialTab: params.initialTab,
		initialOpen: params.initialOpen,
	})
	if (res.action === 'exit') return
	process.stdout.write('Starting HMR (Ctrl+C to stop)…\n')
	if (params.startCmd) {
		await spawnStartCommand({ rootDir: params.rootDir, command: params.startCmd, env: params.env })
	} else {
		await spawnPluxelHmrStart(params.rootDir, res.snapshotJson)
	}
}

export const hmrCommand = define({
	name: 'hmr',
	description: 'HMR workspace profiles (tui/start/doctor)',
	args: hmrCommandArgs,
	async run(ctx) {
		const values = ctx.values as HmrValues
		const [actionRaw] = normalizePositionals(ctx.name, ctx.positionals)
		const action = (actionRaw || 'prompt').toLowerCase()

		const startCmdFlag = values.startCmd ?? values['start-cmd']
		const builtinSetFlag = values.builtinSet ?? values['builtin-set']
		const enabledSetFlag = values.enabledSet ?? values['enabled-set']

		const rootDir = resolve(process.cwd(), values.root || '.')
		const configPath = resolve(rootDir, values.config || DEFAULT_HMR_CONFIG_BASENAME)

		const env = {
			...process.env,
			...(values.profile ? { PLUXEL_HMR_PROFILE: values.profile } : {}),
			...(startCmdFlag ? { PLUXEL_HMR_START_CMD: startCmdFlag } : {}),
		}
		const startCmd = env.PLUXEL_HMR_START_CMD
		const skipPackages = new Set(parseEnvList(env.PLUXEL_HMR_SKIP_PACKAGES))

		if (action === 'doctor') {
			const res = await diagnoseWorkspace({ rootDir, configPath, env })
			if (!res.ok) {
				printHeading('pluxel hmr doctor: blocked')
				process.stderr.write(`${res.errors.join('\n')}\n`)
				if (res.discovered?.length) {
					writeHmrDiscoveredIndex({
						rootDir,
						configPath,
						activeProfile: values.profile ?? env.PLUXEL_HMR_PROFILE ?? 'unknown',
						hiddenPackages: [...skipPackages],
						discovered: res.discovered,
					})
					printHeading('Discovered plugin packages')
					process.stdout.write(formatList(res.discovered.map((p) => `${p.name} -> ${p.entry}`)))
					process.stdout.write('\n')
				}
				throw new Error('doctor failed')
			}

			printHeading('pluxel hmr doctor: ok')
			if (res.warnings.length) {
				printHeading('Warnings')
				process.stdout.write(`${res.warnings.join('\n')}\n`)
			}

			const s = res.snapshot
			writeHmrDiscoveredIndex({
				rootDir,
				configPath,
				activeProfile: s.activeProfile,
				rootsExpandedAbs: s.roots.map((r) => resolve(rootDir, r)),
				excludeGlobs: s.excludeGlobs,
				hiddenPackages: [...skipPackages],
				builtinPackages: s.builtinPackages,
				omitFromEntries: s.builtinPackages,
				discovered: s.discovered,
			})

			printHeading('Summary')
			process.stdout.write(
				[
					`profile: ${s.activeProfile}`,
					`enabled: ${s.enabled.length}`,
					`discovered: ${s.discovered.length}`,
					`startup entries: ${s.enabledEntries.length} (+include ${s.includedEntries.length})`,
					`watch roots: ${s.watchRoots.length}`,
				].join('\n') + '\n',
			)

			if (s.discovered.length) {
				printHeading('Discovered plugin packages')
				process.stdout.write(formatList(s.discovered.map((p) => `${p.name} -> ${p.entry}`)))
				process.stdout.write('\n')
			}
			if (s.includedEntries.length) {
				printHeading('Resolved include entries')
				process.stdout.write(formatList(s.includedEntries))
				process.stdout.write('\n')
			}

			return
		}

		if (action === 'start') {
			const res = await diagnoseWorkspace({ rootDir, configPath, env })
			if (!res.ok) {
				process.stderr.write('HMR start blocked by workspace errors.\n')
				process.stderr.write(`${res.errors.join('\n')}\n`)
				throw new Error('start blocked')
			}

			for (const w of res.warnings) process.stdout.write(`${w}\n`)
			writeHmrDiscoveredIndex({
				rootDir,
				configPath,
				activeProfile: res.snapshot.activeProfile,
				rootsExpandedAbs: res.snapshot.roots.map((r) => resolve(rootDir, r)),
				excludeGlobs: res.snapshot.excludeGlobs,
				hiddenPackages: [...skipPackages],
				builtinPackages: res.snapshot.builtinPackages,
				omitFromEntries: res.snapshot.builtinPackages,
				discovered: res.snapshot.discovered,
			})

			process.stdout.write('Starting HMR (Ctrl+C to stop)…\n')
			if (startCmd) {
				await spawnStartCommand({ rootDir, command: startCmd, env })
			} else {
				await spawnPluxelHmrStart(rootDir, JSON.stringify(res.snapshot))
			}
			return
		}

		if (action === 'enabled' || action === 'enable') {
			if (enabledSetFlag) {
				if (!existsSync(configPath)) {
					throw new Error(`Missing config file: ${configPath} (run \`pluxel hmr\` first)`)
				}
				const cfg = readHmrConfigV1(configPath)
				const activeProfile = resolveActiveProfile({
					cfg,
					valuesProfile: values.profile,
					envProfile: env.PLUXEL_HMR_PROFILE,
				})
				ensureProfile(cfg, activeProfile)
				const currentProfile: HmrProfile = cfg.profiles[activeProfile] ?? { enabled: [] }
				const nextEnabled = uniqPreserveOrder(splitList(String(enabledSetFlag)))
				const nextBuiltin = (currentProfile.builtin ?? []).filter((n) => !nextEnabled.includes(n))
				cfg.profiles[activeProfile] = {
					...currentProfile,
					enabled: nextEnabled,
					...(nextBuiltin.length ? { builtin: nextBuiltin } : {}),
				}
				if (!nextBuiltin.length) delete cfg.profiles[activeProfile]!.builtin
				writeHmrConfigV1(configPath, cfg)
				process.stdout.write(`Wrote ${configPath}\n`)
				return
			}

			await runTui({
				rootDir,
				configPath,
				env,
				skipPackages,
				initialTab: 'packages',
				initialOpen: { kind: 'packages', mode: 'enabled' },
				startCmd,
			})
			return
		}

		if (action === 'builtin' || action === 'builtins') {
			if (builtinSetFlag) {
				if (!existsSync(configPath)) {
					throw new Error(`Missing config file: ${configPath} (run \`pluxel hmr\` first)`)
				}
				const cfg = readHmrConfigV1(configPath)
				const activeProfile = resolveActiveProfile({
					cfg,
					valuesProfile: values.profile,
					envProfile: env.PLUXEL_HMR_PROFILE,
				})
				ensureProfile(cfg, activeProfile)
				const currentProfile: HmrProfile = cfg.profiles[activeProfile] ?? { enabled: [] }
				const nextBuiltin = uniqPreserveOrder(splitList(String(builtinSetFlag)))
				const nextEnabled = (currentProfile.enabled ?? []).filter((n) => !nextBuiltin.includes(n))
				cfg.profiles[activeProfile] = {
					...currentProfile,
					enabled: nextEnabled,
					...(nextBuiltin.length ? { builtin: nextBuiltin } : {}),
				}
				if (!nextBuiltin.length) delete cfg.profiles[activeProfile]!.builtin
				writeHmrConfigV1(configPath, cfg)
				process.stdout.write(`Wrote ${configPath}\n`)
				return
			}

			await runTui({
				rootDir,
				configPath,
				env,
				skipPackages,
				initialTab: 'packages',
				initialOpen: { kind: 'packages', mode: 'builtin' },
				startCmd,
			})
			return
		}

		if (action !== 'prompt' && action !== 'interactive') {
			throw new Error(`Unknown action: ${action}`)
		}

		await runTui({ rootDir, configPath, env, skipPackages, startCmd })
	},
})
