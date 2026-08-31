import { mkdir, rm, writeFile } from 'node:fs/promises'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { federation, type ModuleFederationOptions } from '@module-federation/vite'
import { build, type InlineConfig, type PluginOption } from 'vite'
import {
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE,
	WORKBENCH_FEDERATION_SHARE_STRATEGY,
} from '@pluxel/core/federation'
import { resolve } from 'pathe'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/vite'

let activeFederationBuilds = 0
let previousTestEnvOverride: string | undefined

export type WorkbenchUiWorkerPayload = Readonly<{
	root: string
	applicationRoot: string
	declarationRoot: string
	outDir: string
	producer: string
	exposes: Readonly<Record<string, string>>
	cacheDir: string
	shared: ModuleFederationOptions['shared']
	bridgeReactEntry: string
	minify: boolean
	sourcemap: boolean
	paraglide: Readonly<{ project: string; outdir: string }> | null
}>

export async function runWorkbenchUiWorker(payload: WorkbenchUiWorkerPayload): Promise<void> {
	const restoreTestEnv = enterFederationBuildEnvironment()
	try {
		const dtsTsConfigPath = await writeDtsTsConfig(payload)
		const config: InlineConfig = {
			configFile: false,
			// MF inspects host-provided shared exports from Vite's project root. Source imports still
			// resolve from their absolute producer files, while the application root guarantees that
			// every fixed shared winner is locally inspectable even for a nested package producer.
			root: payload.applicationRoot,
			cacheDir: payload.cacheDir,
			publicDir: false,
			clearScreen: false,
			logLevel: 'error',
			resolve: {
				preserveSymlinks: false,
				tsconfigPaths: true,
				alias: [
					{
						find: /^@module-federation\/bridge-react$/,
						replacement: payload.bridgeReactEntry,
					},
				],
			},
			plugins: createPlugins(payload, dtsTsConfigPath),
			build: {
				outDir: payload.outDir,
				emptyOutDir: true,
				target: 'chrome89',
				manifest: false,
				minify: payload.minify,
				cssCodeSplit: true,
				sourcemap: payload.sourcemap,
				rollupOptions: {
					input: Object.fromEntries(
						Object.entries(payload.exposes).map(([expose, entry]) => [
							expose.slice('./views/'.length),
							entry,
						]),
					),
				},
			},
			server: { watch: null },
		}
		await build(config)
	} catch (error) {
		await rm(payload.outDir, { recursive: true, force: true })
		throw error
	} finally {
		try {
			await rm(payload.cacheDir, { recursive: true, force: true })
		} finally {
			restoreTestEnv()
		}
	}
}

function enterFederationBuildEnvironment(): () => void {
	if (activeFederationBuilds === 0) {
		previousTestEnvOverride = process.env.MFE_VITE_NO_TEST_ENV_CHECK
		process.env.MFE_VITE_NO_TEST_ENV_CHECK = 'true'
	}
	activeFederationBuilds += 1
	let active = true
	return () => {
		if (!active) return
		active = false
		activeFederationBuilds -= 1
		if (activeFederationBuilds > 0) return
		if (previousTestEnvOverride === undefined) delete process.env.MFE_VITE_NO_TEST_ENV_CHECK
		else process.env.MFE_VITE_NO_TEST_ENV_CHECK = previousTestEnvOverride
		previousTestEnvOverride = undefined
	}
}

async function writeDtsTsConfig(payload: WorkbenchUiWorkerPayload): Promise<string> {
	const path = resolve(payload.cacheDir, 'workbench-dts.tsconfig.json')
	await mkdir(payload.cacheDir, { recursive: true })
	await writeFile(
		path,
		`${JSON.stringify({
			extends: resolve(payload.root, 'tsconfig.json'),
			compilerOptions: {
				allowImportingTsExtensions: true,
				lib: ['ES2024', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
				// The Vite application may be a nested host directory while producers live in sibling
				// workspace packages. Declarations therefore use the common resolution root, not Vite root.
				rootDir: payload.declarationRoot,
				// MF DTS otherwise gives every producer under one application the same
				// node_modules/.cache/mf-types/.tsbuildinfo and races concurrent builds.
				tsBuildInfoFile: resolve(payload.cacheDir, 'workbench.tsbuildinfo'),
			},
		})}\n`,
		'utf-8',
	)
	return path
}

function createPlugins(payload: WorkbenchUiWorkerPayload, dtsTsConfigPath: string): PluginOption[] {
	const sharedSurface = preserveHostProvidedSharedSurface(payload)
	const plugins: PluginOption[] = [
		rejectHostOwnedMantineStyles(),
		sharedSurface.inject,
		PreprocessorDirectives(),
	]
	if (payload.paraglide) {
		plugins.push(
			...toPluginArray(
				paraglideVitePlugin({
					project: payload.paraglide.project,
					outdir: payload.paraglide.outdir,
				}),
			),
		)
	}
	plugins.push(
		...toPluginArray(
			federation({
				name: payload.producer,
				filename: WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE,
				exposes: payload.exposes,
				manifest: { fileName: WORKBENCH_FEDERATION_MANIFEST_FILE },
				dts: {
					consumeTypes: false,
					tsConfigPath: dtsTsConfigPath,
					generateTypes: {
						abortOnError: true,
						compileInChildProcess: false,
						generateAPITypes: true,
					},
				},
				publicPath: 'auto',
				shared: payload.shared,
				shareStrategy: WORKBENCH_FEDERATION_SHARE_STRATEGY,
			}),
		),
		sharedSurface.remove,
	)
	return plugins
}

function preserveHostProvidedSharedSurface(payload: WorkbenchUiWorkerPayload): Readonly<{
	inject: PluginOption
	remove: PluginOption
}> {
	const exposeEntries = new Set(Object.values(payload.exposes).map((entry) => resolve(entry)))
	const requests = Object.entries(payload.shared ?? {})
		.filter(([, config]) => typeof config === 'object' && config?.import === false)
		.map(([request]) => request)
	const marker = '@pluxel-workbench-full-shared-surface'
	// MF's import:false analyzer treats a side-effect import as requiring the complete export
	// surface. The marker declaration is removed after analysis and never reaches the artifact.
	const injectedLines = requests.map(
		(request) => `import ${JSON.stringify(request)} /* ${marker} */`,
	)
	const isExposeEntry = (id: string) => exposeEntries.has(resolve(id.split('?', 1)[0]!))
	return {
		inject: {
			name: 'pluxel-workbench-declare-full-shared-surface',
			enforce: 'pre',
			transform(code, id) {
				if (!injectedLines.length || !isExposeEntry(id)) return
				return { code: `${injectedLines.join('\n')}\n${code}`, map: null }
			},
		},
		remove: {
			name: 'pluxel-workbench-remove-shared-surface-declarations',
			enforce: 'post',
			transform(code, id) {
				if (!code.includes(marker) || !isExposeEntry(id)) return
				return {
					code: code
						.split('\n')
						.filter((line) => !line.includes(marker))
						.join('\n'),
					map: null,
				}
			},
		},
	}
}

function rejectHostOwnedMantineStyles(): PluginOption {
	return {
		name: 'pluxel-workbench-host-owned-mantine-styles',
		enforce: 'pre',
		resolveId(source) {
			if (
				source === '@mantine/core/styles.css' ||
				source === '@mantine/core/styles.layer.css' ||
				source.startsWith('@mantine/core/styles/')
			) {
				throw new Error(
					'[workbench-ui] Mantine core styles are provided once by the Workbench Shell; remove the remote stylesheet import',
				)
			}
		},
	}
}

function toPluginArray(input: unknown): PluginOption[] {
	if (Array.isArray(input)) return input.flatMap((item) => toPluginArray(item))
	if (!input) return []
	return [input as PluginOption]
}
