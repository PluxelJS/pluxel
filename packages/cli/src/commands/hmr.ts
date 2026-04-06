import { existsSync } from 'node:fs'
import {
	DEFAULT_HMR_CONFIG_BASENAME,
	diagnoseWorkspace,
	type PluxelHmrConfigV1,
	type WorkspaceSnapshot,
	readHmrConfigV1,
	uniqPreserveOrder,
	writeHmrConfigV1,
} from '@pluxel/hmr/diagnose'
import { type ArgValues, define } from 'gunshi'
import { resolve } from 'pathe'
import { writeHmrDiscoveredIndex } from '../hmr/discovered-index'

const hmrCommonArgs = {
	root: {
		type: 'string',
		description: 'Workspace root',
		default: '.',
	},
	config: {
		type: 'string',
		description: 'Config file path',
		default: DEFAULT_HMR_CONFIG_BASENAME,
	},
	profile: {
		type: 'string',
		description: 'Profile name (overrides config.profile for this run)',
	},
} as const

const hmrSetArgs = {
	...hmrCommonArgs,
	set: {
		type: 'string',
		description:
			'Non-interactive package list (comma or newline separated). Writes config directly.',
	},
} as const

type HmrCommonArgs = typeof hmrCommonArgs
type HmrCommonValues = ArgValues<HmrCommonArgs>

type HmrSetArgs = typeof hmrSetArgs
type HmrSetValues = ArgValues<HmrSetArgs>

type HmrProfile = PluxelHmrConfigV1['profiles'][string]

type HmrRuntime = {
	rootDir: string
	configPath: string
	env: Record<string, string | undefined>
}

function splitList(raw: string): string[] {
	return raw
		.split(/[\n,]/g)
		.map((s) => s.trim())
		.filter(Boolean)
}

function ensureProfile(cfg: ReturnType<typeof readHmrConfigV1>, name: string) {
	if (!cfg.profiles[name]) cfg.profiles[name] = { enabled: [] }
}

function resolveActiveProfile(params: {
	cfg: ReturnType<typeof readHmrConfigV1>
	valuesProfile?: string
	envProfile?: string
}) {
	return params.valuesProfile ?? params.envProfile ?? params.cfg.profile
}

function resolveRuntime(values: HmrCommonValues): HmrRuntime {
	const rootDir = resolve(process.cwd(), values.root || '.')
	const configPath = resolve(rootDir, values.config || DEFAULT_HMR_CONFIG_BASENAME)
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...(values.profile ? { PLUXEL_HMR_PROFILE: values.profile } : {}),
	}
	return { rootDir, configPath, env }
}

function formatList(items: string[], max = 60) {
	if (items.length <= max) return items.join('\n')
	const head = items.slice(0, max)
	return `${head.join('\n')}\n... (${items.length - max} more)`
}

function printHeading(title: string) {
	process.stdout.write(`\n${title}\n${'-'.repeat(Math.min(Math.max(title.length, 8), 64))}\n`)
}

function writeSnapshotIndex(runtime: HmrRuntime, snapshot: WorkspaceSnapshot) {
	writeHmrDiscoveredIndex({
		rootDir: runtime.rootDir,
		configPath: runtime.configPath,
		activeProfile: snapshot.activeProfile,
		rootsExpandedAbs: snapshot.roots.map((r) => resolve(runtime.rootDir, r)),
		excludeGlobs: snapshot.excludeGlobs,
		builtinPackages: snapshot.builtinPackages,
		omitFromEntries: snapshot.builtinPackages,
		discovered: snapshot.discovered,
	})
}

async function bootAndStartPlannedHost(
	plan: ReturnType<typeof import('@pluxel/hmr/host').planHmrHost>,
) {
	const { bootPlannedHmrHost } = await import('@pluxel/hmr/host')
	const host = await bootPlannedHmrHost(plan)
	await host.hmr.start()
}

async function startHostFromSnapshot(rootDir: string, snapshotOrJson: unknown) {
	const snapshotModule: typeof import('@pluxel/hmr/snapshot') = await import('@pluxel/hmr/snapshot')
	const { planHmrHost } = await import('@pluxel/hmr/host')

	const snapshot = typeof snapshotOrJson === 'string' ? JSON.parse(snapshotOrJson) : snapshotOrJson
	snapshotModule.assertHmrWorkspaceSnapshot(snapshot)

	await bootAndStartPlannedHost(planHmrHost({ root: rootDir, snapshot }))
}

async function runTui(params: {
	rootDir: string
	configPath: string
	env: Record<string, string | undefined>
	initialTab?: Parameters<typeof import('../tui/hmr-prompt').runHmrPromptTui>[0]['initialTab']
	initialOpen?: Parameters<typeof import('../tui/hmr-prompt').runHmrPromptTui>[0]['initialOpen']
}) {
	const { runHmrPromptTui } = await import('../tui/hmr-prompt')
	const res = await runHmrPromptTui({
		rootDir: params.rootDir,
		configPath: params.configPath,
		env: params.env,
		skipPackages: new Set(),
		initialTab: params.initialTab,
		initialOpen: params.initialOpen,
	})
	if (res.action === 'exit') return
	process.stdout.write('Starting HMR (Ctrl+C to stop)…\n')
	await startHostFromSnapshot(params.rootDir, res.snapshotJson)
}

async function runDoctor(values: HmrCommonValues) {
	const runtime = resolveRuntime(values)
	const res = await diagnoseWorkspace({
		rootDir: runtime.rootDir,
		configPath: runtime.configPath,
		env: runtime.env,
	})

	if (res.ok === false) {
		printHeading('pluxel hmr doctor: blocked')
		process.stderr.write(`${res.errors.join('\n')}\n`)
		if (res.discovered?.length) {
			writeHmrDiscoveredIndex({
				rootDir: runtime.rootDir,
				configPath: runtime.configPath,
				activeProfile: values.profile ?? runtime.env.PLUXEL_HMR_PROFILE ?? 'unknown',
				discovered: res.discovered,
			})
			printHeading('Discovered plugin packages')
			process.stdout.write(formatList(res.discovered.map((p) => `${p.name} -> ${p.entry}`)))
			process.stdout.write('\n')
		}
		throw new Error('doctor failed')
	}

	printHeading('pluxel hmr doctor: ok')
	if (res.warnings.length > 0) {
		printHeading('Warnings')
		process.stdout.write(`${res.warnings.join('\n')}\n`)
	}

	const s = res.snapshot
	writeSnapshotIndex(runtime, s)

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

	if (s.discovered.length > 0) {
		printHeading('Discovered plugin packages')
		process.stdout.write(formatList(s.discovered.map((p) => `${p.name} -> ${p.entry}`)))
		process.stdout.write('\n')
	}
	if (s.includedEntries.length > 0) {
		printHeading('Resolved include entries')
		process.stdout.write(formatList(s.includedEntries))
		process.stdout.write('\n')
	}
}

async function runStart(values: HmrCommonValues) {
	const runtime = resolveRuntime(values)
	const { planHmrHostFromConfig } = await import('@pluxel/hmr/host')
	const plan = await planHmrHostFromConfig({
		root: runtime.rootDir,
		configPath: runtime.configPath,
		env: runtime.env,
	})

	for (const w of plan.warnings) process.stdout.write(`${w}\n`)
	writeSnapshotIndex(runtime, plan.snapshot)

	process.stdout.write('Starting HMR (Ctrl+C to stop)…\n')
	await bootAndStartPlannedHost(plan)
}

async function runPrompt(values: HmrCommonValues) {
	const runtime = resolveRuntime(values)
	await runTui({ rootDir: runtime.rootDir, configPath: runtime.configPath, env: runtime.env })
}

async function runEnabled(values: HmrSetValues) {
	const runtime = resolveRuntime(values)
	if (values.set) {
		if (!existsSync(runtime.configPath)) {
			throw new Error(`Missing config file: ${runtime.configPath} (run \`pluxel hmr\` first)`)
		}
		const cfg = readHmrConfigV1(runtime.configPath)
		const activeProfile = resolveActiveProfile({
			cfg,
			valuesProfile: values.profile,
			envProfile: runtime.env.PLUXEL_HMR_PROFILE,
		})
		ensureProfile(cfg, activeProfile)
		const currentProfile: HmrProfile = cfg.profiles[activeProfile] ?? { enabled: [] }
		const nextEnabled = uniqPreserveOrder(splitList(String(values.set)))
		const nextBuiltin = (currentProfile.builtin ?? []).filter((n) => !nextEnabled.includes(n))
		cfg.profiles[activeProfile] = {
			...currentProfile,
			enabled: nextEnabled,
			...(nextBuiltin.length > 0 ? { builtin: nextBuiltin } : {}),
		}
		if (nextBuiltin.length === 0) delete cfg.profiles[activeProfile]!.builtin
		writeHmrConfigV1(runtime.configPath, cfg)
		process.stdout.write(`Wrote ${runtime.configPath}\n`)
		return
	}

	await runTui({
		rootDir: runtime.rootDir,
		configPath: runtime.configPath,
		env: runtime.env,
		initialTab: 'packages',
		initialOpen: { kind: 'packages', mode: 'enabled' },
	})
}

async function runBuiltin(values: HmrSetValues) {
	const runtime = resolveRuntime(values)
	if (values.set) {
		if (!existsSync(runtime.configPath)) {
			throw new Error(`Missing config file: ${runtime.configPath} (run \`pluxel hmr\` first)`)
		}
		const cfg = readHmrConfigV1(runtime.configPath)
		const activeProfile = resolveActiveProfile({
			cfg,
			valuesProfile: values.profile,
			envProfile: runtime.env.PLUXEL_HMR_PROFILE,
		})
		ensureProfile(cfg, activeProfile)
		const currentProfile: HmrProfile = cfg.profiles[activeProfile] ?? { enabled: [] }
		const nextBuiltin = uniqPreserveOrder(splitList(String(values.set)))
		const nextEnabled = (currentProfile.enabled ?? []).filter((n) => !nextBuiltin.includes(n))
		cfg.profiles[activeProfile] = {
			...currentProfile,
			enabled: nextEnabled,
			...(nextBuiltin.length > 0 ? { builtin: nextBuiltin } : {}),
		}
		if (nextBuiltin.length === 0) delete cfg.profiles[activeProfile]!.builtin
		writeHmrConfigV1(runtime.configPath, cfg)
		process.stdout.write(`Wrote ${runtime.configPath}\n`)
		return
	}

	await runTui({
		rootDir: runtime.rootDir,
		configPath: runtime.configPath,
		env: runtime.env,
		initialTab: 'packages',
		initialOpen: { kind: 'packages', mode: 'builtin' },
	})
}

const hmrPromptCommand = define({
	name: 'prompt',
	description: 'Open interactive HMR prompt',
	toKebab: true,
	args: hmrCommonArgs,
	async run(ctx) {
		await runPrompt(ctx.values as HmrCommonValues)
	},
})

const hmrStartCommand = define({
	name: 'start',
	description: 'Diagnose workspace and start HMR',
	toKebab: true,
	args: hmrCommonArgs,
	async run(ctx) {
		await runStart(ctx.values as HmrCommonValues)
	},
})

const hmrDoctorCommand = define({
	name: 'doctor',
	description: 'Diagnose workspace and print HMR snapshot summary',
	toKebab: true,
	args: hmrCommonArgs,
	async run(ctx) {
		await runDoctor(ctx.values as HmrCommonValues)
	},
})

const hmrEnabledCommand = define({
	name: 'enabled',
	description: 'Edit enabled plugin set (TUI or --set)',
	toKebab: true,
	args: hmrSetArgs,
	async run(ctx) {
		await runEnabled(ctx.values as HmrSetValues)
	},
})

const hmrBuiltinCommand = define({
	name: 'builtin',
	description: 'Edit builtin plugin set (TUI or --set)',
	toKebab: true,
	args: hmrSetArgs,
	async run(ctx) {
		await runBuiltin(ctx.values as HmrSetValues)
	},
})

export const hmrCommand = define({
	name: 'hmr',
	description: 'HMR workspace profiles (prompt/start/doctor)',
	toKebab: true,
	args: hmrCommonArgs,
	subCommands: new Map([
		['prompt', hmrPromptCommand],
		['start', hmrStartCommand],
		['doctor', hmrDoctorCommand],
		['enabled', hmrEnabledCommand],
		['builtin', hmrBuiltinCommand],
	]),
	async run(ctx) {
		await runPrompt(ctx.values as HmrCommonValues)
	},
})
