import { existsSync } from 'node:fs'
import type {
	LoaderHmrWorkspace,
	PluxelLoaderHmrConfigV2,
} from '@pluxel/runtime-dynamic/hmr/diagnose'
import { type ArgValues, define } from 'gunshi'
import { resolve } from 'pathe'
import { loadOfficialCapability } from '../capability-loader'
import {
	hmrCommandDefinition,
	loaderHmrCommonArgs,
	loaderHmrDoctorDefinition,
	loaderHmrEnabledDefinition,
	loaderHmrPromptDefinition,
	loaderHmrSetArgs,
} from '../command-manifest'
import { writeLoaderHmrDiscoveredIndex } from '../hmr/discovered-index'

type LoaderHmrCommonArgs = typeof loaderHmrCommonArgs
type LoaderHmrCommonValues = ArgValues<LoaderHmrCommonArgs>

type LoaderHmrSetArgs = typeof loaderHmrSetArgs
type LoaderHmrSetValues = ArgValues<LoaderHmrSetArgs>
type LoaderHmrDiagnoseModule = typeof import('@pluxel/runtime-dynamic/hmr/diagnose')

type LoaderHmrCommandContext = {
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

function ensureProfile(cfg: PluxelLoaderHmrConfigV2, name: string) {
	if (!cfg.profiles[name]) cfg.profiles[name] = { enabled: [] }
}

function resolveActiveProfile(params: {
	cfg: PluxelLoaderHmrConfigV2
	valuesProfile?: string
	envProfile?: string
}) {
	return params.valuesProfile ?? params.envProfile ?? params.cfg.profile
}

function resolveCommandContext(values: LoaderHmrCommonValues): LoaderHmrCommandContext {
	const rootDir = resolve(process.cwd(), values.root || '.')
	const configPath = resolve(rootDir, values.config || 'pluxel.loader.hmr.jsonc')
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

function writeSnapshotIndex(context: LoaderHmrCommandContext, snapshot: LoaderHmrWorkspace) {
	writeLoaderHmrDiscoveredIndex({
		rootDir: context.rootDir,
		configPath: context.configPath,
		activeProfile: snapshot.activeProfile,
		rootsExpandedAbs: snapshot.roots.map((r) => resolve(context.rootDir, r)),
		excludeGlobs: snapshot.excludeGlobs,
		discovered: snapshot.discovered,
	})
}

async function runTui(params: {
	rootDir: string
	configPath: string
	env: Record<string, string | undefined>
	initialTab?: Parameters<typeof import('../tui/hmr-prompt').runLoaderHmrPromptTui>[0]['initialTab']
	initialOpen?: Parameters<
		typeof import('../tui/hmr-prompt').runLoaderHmrPromptTui
	>[0]['initialOpen']
}) {
	const [diagnose, { runLoaderHmrPromptTui }] = await Promise.all([
		loadOfficialCapability<LoaderHmrDiagnoseModule>('runtime-dynamic-hmr-diagnose'),
		import('../tui/hmr-prompt'),
	])
	const res = await runLoaderHmrPromptTui({
		rootDir: params.rootDir,
		configPath: params.configPath,
		env: params.env,
		diagnose,
		skipPackages: new Set(),
		initialTab: params.initialTab,
		initialOpen: params.initialOpen,
	})
	if (res.action === 'exit') return
}

async function runDoctor(values: LoaderHmrCommonValues) {
	const { diagnoseLoaderHmrWorkspace } = await loadOfficialCapability<LoaderHmrDiagnoseModule>(
		'runtime-dynamic-hmr-diagnose',
	)
	const context = resolveCommandContext(values)
	const res = await diagnoseLoaderHmrWorkspace({
		rootDir: context.rootDir,
		configPath: context.configPath,
		env: context.env,
	})

	if (res.ok === false) {
		printHeading('pluxel hmr doctor: blocked')
		process.stderr.write(`${res.errors.join('\n')}\n`)
		if (res.discovered?.length) {
			writeLoaderHmrDiscoveredIndex({
				rootDir: context.rootDir,
				configPath: context.configPath,
				activeProfile: values.profile ?? context.env.PLUXEL_HMR_PROFILE ?? 'unknown',
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
	writeSnapshotIndex(context, s)

	printHeading('Summary')
	process.stdout.write(
		[
			`profile: ${s.activeProfile}`,
			`selected packages: ${s.enabled.length}`,
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

async function runPrompt(values: LoaderHmrCommonValues) {
	const context = resolveCommandContext(values)
	await runTui({ rootDir: context.rootDir, configPath: context.configPath, env: context.env })
}

async function runEnabled(values: LoaderHmrSetValues) {
	const context = resolveCommandContext(values)
	if (values.set) {
		const { readLoaderHmrConfigV2, writeLoaderHmrConfigV2 } =
			await loadOfficialCapability<LoaderHmrDiagnoseModule>('runtime-dynamic-hmr-diagnose')
		if (!existsSync(context.configPath)) {
			throw new Error(`Missing config file: ${context.configPath} (run \`pluxel hmr\` first)`)
		}
		const cfg = readLoaderHmrConfigV2(context.configPath)
		const activeProfile = resolveActiveProfile({
			cfg,
			valuesProfile: values.profile,
			envProfile: context.env.PLUXEL_HMR_PROFILE,
		})
		ensureProfile(cfg, activeProfile)
		const nextEnabled = uniqPreserveOrder(splitList(String(values.set)))
		cfg.profiles[activeProfile] = {
			...(cfg.profiles[activeProfile] ?? { enabled: [] }),
			enabled: nextEnabled,
		}
		writeLoaderHmrConfigV2(context.configPath, cfg)
		process.stdout.write(`Wrote ${context.configPath}\n`)
		return
	}

	await runTui({
		rootDir: context.rootDir,
		configPath: context.configPath,
		env: context.env,
		initialTab: 'packages',
		initialOpen: { kind: 'packages' },
	})
}

export const loaderHmrPromptCommand = define({
	...loaderHmrPromptDefinition,
	async run(ctx) {
		await runPrompt(ctx.values as LoaderHmrCommonValues)
	},
})

export const loaderHmrDoctorCommand = define({
	...loaderHmrDoctorDefinition,
	async run(ctx) {
		await runDoctor(ctx.values as LoaderHmrCommonValues)
	},
})

export const loaderHmrEnabledCommand = define({
	...loaderHmrEnabledDefinition,
	async run(ctx) {
		await runEnabled(ctx.values as LoaderHmrSetValues)
	},
})

export const hmrCommand = define({
	...hmrCommandDefinition,
	async run(ctx) {
		await runPrompt(ctx.values as LoaderHmrCommonValues)
	},
})
