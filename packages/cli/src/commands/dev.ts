import { existsSync } from 'node:fs'
import {
	DEFAULT_LOADER_DEV_CONFIG_BASENAME,
	assertLoaderDevWorkspace,
	createLoaderDevHost,
	createLoaderDevHostFromWorkspace,
	diagnoseLoaderDevWorkspace,
	type PluxelLoaderDevConfigV1,
	type LoaderDevWorkspace,
	defineLoaderDevConfig,
	readLoaderDevConfigV1,
	writeLoaderDevConfigV1,
} from '@pluxel/runtime-loader/dev'
import { type ArgValues, define } from 'gunshi'
import { resolve } from 'pathe'
import { writeLoaderDevDiscoveredIndex } from '../dev/discovered-index'

const loaderDevCommonArgs = {
	root: {
		type: 'string',
		description: 'Workspace root',
		default: '.',
	},
	config: {
		type: 'string',
		description: 'Config file path',
		default: DEFAULT_LOADER_DEV_CONFIG_BASENAME,
	},
	profile: {
		type: 'string',
		description: 'Profile name (overrides config.profile for this run)',
	},
} as const

const loaderDevSetArgs = {
	...loaderDevCommonArgs,
	set: {
		type: 'string',
		description:
			'Non-interactive package list (comma or newline separated). Writes config directly.',
	},
} as const

type LoaderDevCommonArgs = typeof loaderDevCommonArgs
type LoaderDevCommonValues = ArgValues<LoaderDevCommonArgs>

type LoaderDevSetArgs = typeof loaderDevSetArgs
type LoaderDevSetValues = ArgValues<LoaderDevSetArgs>

type LoaderDevProfile = PluxelLoaderDevConfigV1['profiles'][string]

type LoaderDevRuntime = {
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

function uniqPreserveOrder(items: readonly string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const raw of items) {
		const item = String(raw)
		if (seen.has(item)) continue
		seen.add(item)
		out.push(item)
	}
	return out
}

function ensureProfile(cfg: ReturnType<typeof readLoaderDevConfigV1>, name: string) {
	if (!cfg.profiles[name]) cfg.profiles[name] = { enabled: [] }
}

function resolveActiveProfile(params: {
	cfg: ReturnType<typeof readLoaderDevConfigV1>
	valuesProfile?: string
	envProfile?: string
}) {
	return params.valuesProfile ?? params.envProfile ?? params.cfg.profile
}

function resolveRuntime(values: LoaderDevCommonValues): LoaderDevRuntime {
	const rootDir = resolve(process.cwd(), values.root || '.')
	const configPath = resolve(rootDir, values.config || DEFAULT_LOADER_DEV_CONFIG_BASENAME)
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...(values.profile ? { PLUXEL_DEV_PROFILE: values.profile } : {}),
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

function writeSnapshotIndex(runtime: LoaderDevRuntime, snapshot: LoaderDevWorkspace) {
	writeLoaderDevDiscoveredIndex({
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

async function startHostFromSnapshot(rootDir: string, snapshotOrJson: unknown) {
	const snapshot = typeof snapshotOrJson === 'string' ? JSON.parse(snapshotOrJson) : snapshotOrJson
	assertLoaderDevWorkspace(snapshot)

	const host = await createLoaderDevHostFromWorkspace({ root: rootDir, snapshot })
	await host.start()
}

async function runTui(params: {
	rootDir: string
	configPath: string
	env: Record<string, string | undefined>
	initialTab?: Parameters<typeof import('../tui/dev-prompt').runLoaderDevPromptTui>[0]['initialTab']
	initialOpen?: Parameters<typeof import('../tui/dev-prompt').runLoaderDevPromptTui>[0]['initialOpen']
}) {
	const { runLoaderDevPromptTui } = await import('../tui/dev-prompt')
	const res = await runLoaderDevPromptTui({
		rootDir: params.rootDir,
		configPath: params.configPath,
		env: params.env,
		skipPackages: new Set(),
		initialTab: params.initialTab,
		initialOpen: params.initialOpen,
	})
	if (res.action === 'exit') return
	process.stdout.write('Starting loader dev host (Ctrl+C to stop)…\n')
	await startHostFromSnapshot(params.rootDir, res.snapshotJson)
}

async function runDoctor(values: LoaderDevCommonValues) {
	const runtime = resolveRuntime(values)
	const res = await diagnoseLoaderDevWorkspace({
		rootDir: runtime.rootDir,
		configPath: runtime.configPath,
		env: runtime.env,
	})

	if (res.ok === false) {
		printHeading('pluxel dev doctor: blocked')
		process.stderr.write(`${res.errors.join('\n')}\n`)
		if (res.discovered?.length) {
			writeLoaderDevDiscoveredIndex({
				rootDir: runtime.rootDir,
				configPath: runtime.configPath,
				activeProfile: values.profile ?? runtime.env.PLUXEL_DEV_PROFILE ?? 'unknown',
				discovered: res.discovered,
			})
			printHeading('Discovered plugin packages')
			process.stdout.write(formatList(res.discovered.map((p) => `${p.name} -> ${p.entry}`)))
			process.stdout.write('\n')
		}
		throw new Error('doctor failed')
	}

	printHeading('pluxel dev doctor: ok')
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

async function runStart(values: LoaderDevCommonValues) {
	const runtime = resolveRuntime(values)
	const host = await createLoaderDevHost({
		config: defineLoaderDevConfig({
			root: runtime.rootDir,
			configPath: runtime.configPath,
			env: runtime.env,
		}),
	})

	for (const w of host.warnings) process.stdout.write(`${w}\n`)
	writeSnapshotIndex(runtime, host.workspace as LoaderDevWorkspace)

	process.stdout.write('Starting loader dev host (Ctrl+C to stop)…\n')
	await host.start()
}

async function runPrompt(values: LoaderDevCommonValues) {
	const runtime = resolveRuntime(values)
	await runTui({ rootDir: runtime.rootDir, configPath: runtime.configPath, env: runtime.env })
}

async function runEnabled(values: LoaderDevSetValues) {
	const runtime = resolveRuntime(values)
	if (values.set) {
		if (!existsSync(runtime.configPath)) {
			throw new Error(`Missing config file: ${runtime.configPath} (run \`pluxel dev\` first)`)
		}
		const cfg = readLoaderDevConfigV1(runtime.configPath)
		const activeProfile = resolveActiveProfile({
			cfg,
			valuesProfile: values.profile,
			envProfile: runtime.env.PLUXEL_DEV_PROFILE,
		})
		ensureProfile(cfg, activeProfile)
		const currentProfile: LoaderDevProfile = cfg.profiles[activeProfile] ?? { enabled: [] }
		const nextEnabled = uniqPreserveOrder(splitList(String(values.set)))
		const nextBuiltin = (currentProfile.builtin ?? []).filter((n) => !nextEnabled.includes(n))
		cfg.profiles[activeProfile] = {
			...currentProfile,
			enabled: nextEnabled,
			...(nextBuiltin.length > 0 ? { builtin: nextBuiltin } : {}),
		}
		if (nextBuiltin.length === 0) delete cfg.profiles[activeProfile]!.builtin
		writeLoaderDevConfigV1(runtime.configPath, cfg)
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

async function runBuiltin(values: LoaderDevSetValues) {
	const runtime = resolveRuntime(values)
	if (values.set) {
		if (!existsSync(runtime.configPath)) {
			throw new Error(`Missing config file: ${runtime.configPath} (run \`pluxel dev\` first)`)
		}
		const cfg = readLoaderDevConfigV1(runtime.configPath)
		const activeProfile = resolveActiveProfile({
			cfg,
			valuesProfile: values.profile,
			envProfile: runtime.env.PLUXEL_DEV_PROFILE,
		})
		ensureProfile(cfg, activeProfile)
		const currentProfile: LoaderDevProfile = cfg.profiles[activeProfile] ?? { enabled: [] }
		const nextBuiltin = uniqPreserveOrder(splitList(String(values.set)))
		const nextEnabled = (currentProfile.enabled ?? []).filter((n) => !nextBuiltin.includes(n))
		cfg.profiles[activeProfile] = {
			...currentProfile,
			enabled: nextEnabled,
			...(nextBuiltin.length > 0 ? { builtin: nextBuiltin } : {}),
		}
		if (nextBuiltin.length === 0) delete cfg.profiles[activeProfile]!.builtin
		writeLoaderDevConfigV1(runtime.configPath, cfg)
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

const loaderDevPromptCommand = define({
	name: 'prompt',
	description: 'Open interactive loader dev prompt',
	toKebab: true,
	args: loaderDevCommonArgs,
	async run(ctx) {
		await runPrompt(ctx.values as LoaderDevCommonValues)
	},
})

const loaderDevStartCommand = define({
	name: 'start',
	description: 'Diagnose workspace and start loader dev host',
	toKebab: true,
	args: loaderDevCommonArgs,
	async run(ctx) {
		await runStart(ctx.values as LoaderDevCommonValues)
	},
})

const loaderDevDoctorCommand = define({
	name: 'doctor',
	description: 'Diagnose workspace and print loader dev summary',
	toKebab: true,
	args: loaderDevCommonArgs,
	async run(ctx) {
		await runDoctor(ctx.values as LoaderDevCommonValues)
	},
})

const loaderDevEnabledCommand = define({
	name: 'enabled',
	description: 'Edit enabled plugin set (TUI or --set)',
	toKebab: true,
	args: loaderDevSetArgs,
	async run(ctx) {
		await runEnabled(ctx.values as LoaderDevSetValues)
	},
})

const loaderDevBuiltinCommand = define({
	name: 'builtin',
	description: 'Edit builtin plugin set (TUI or --set)',
	toKebab: true,
	args: loaderDevSetArgs,
	async run(ctx) {
		await runBuiltin(ctx.values as LoaderDevSetValues)
	},
})

export const devCommand = define({
	name: 'dev',
	description: 'Loader dev workspace profiles (prompt/start/doctor)',
	toKebab: true,
	args: loaderDevCommonArgs,
	subCommands: new Map([
		['prompt', loaderDevPromptCommand],
		['start', loaderDevStartCommand],
		['doctor', loaderDevDoctorCommand],
		['enabled', loaderDevEnabledCommand],
		['builtin', loaderDevBuiltinCommand],
	]),
	async run(ctx) {
		await runPrompt(ctx.values as LoaderDevCommonValues)
	},
})
