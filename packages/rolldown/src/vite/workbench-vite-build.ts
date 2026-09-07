import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { federation, type ModuleFederationOptions } from '@module-federation/vite'
import { build, type InlineConfig, type Plugin, type PluginOption } from 'vite'
import {
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE,
	WORKBENCH_FEDERATION_SHARE_STRATEGY,
	type WorkbenchFederationTypeAssetPolicy,
} from '@pluxel/core/federation'
import { dirname, resolve } from 'pathe'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/vite'

// DTS generation is owned by this toolchain; a producer is not required to install TypeScript.
const toolchainRequire = createRequire(import.meta.url)
const toolchainTypeScriptRoot = dirname(toolchainRequire.resolve('typescript/package.json'))

let activeFederationTestBuilds = 0
let previousTestEnvironmentOverride: string | undefined

export type WorkbenchViteBuildOptions = Readonly<{
	producerRoot: string
	applicationRoot: string
	packageMode: 'development' | 'distribution'
	declarationRoot: string
	outDir: string
	producer: string
	exposes: Readonly<Record<string, string>>
	cacheDir: string
	shared: ModuleFederationOptions['shared']
	bridgeReactEntry: string
	minify: boolean
	sourcemap: boolean
	typeAssets: WorkbenchFederationTypeAssetPolicy
	paraglide: Readonly<{ project: string; outdir: string }> | null
}>

export async function runWorkbenchViteBuild(options: WorkbenchViteBuildOptions): Promise<void> {
	const restoreTestEnvironment = enableFederationInTestEnvironment()
	try {
		const dtsTsConfigPath =
			options.typeAssets === 'required' ? await writeDtsTsConfig(options) : null
		await build(createViteConfig(options, dtsTsConfigPath))
	} finally {
		restoreTestEnvironment()
	}
}

function createViteConfig(
	options: WorkbenchViteBuildOptions,
	dtsTsConfigPath: string | null,
): InlineConfig {
	return {
		configFile: false,
		// MF inspects host-provided shared exports from Vite's project root. Source imports still
		// resolve from their absolute producer files, while the application root guarantees that
		// every fixed shared winner is locally inspectable even for a nested package producer.
		root: options.applicationRoot,
		cacheDir: options.cacheDir,
		publicDir: false,
		clearScreen: false,
		logLevel: 'error',
		resolve: {
			conditions: workbenchPackageConditions(options.packageMode),
			preserveSymlinks: false,
			tsconfigPaths: true,
			alias: [
				{
					find: /^@module-federation\/bridge-react$/,
					replacement: options.bridgeReactEntry,
				},
			],
		},
		plugins: createPlugins(options, dtsTsConfigPath),
		build: {
			outDir: options.outDir,
			emptyOutDir: true,
			target: 'chrome89',
			manifest: false,
			minify: options.minify,
			cssCodeSplit: true,
			sourcemap: options.sourcemap,
			rollupOptions: {
				input: Object.fromEntries(
					Object.entries(options.exposes).map(([expose, entry]) => [
						expose.slice('./views/'.length),
						entry,
					]),
				),
			},
		},
		server: { watch: null },
	}
}

function workbenchPackageConditions(
	packageMode: WorkbenchViteBuildOptions['packageMode'],
): string[] {
	return [...workbenchCustomConditions(packageMode), 'module', 'browser', 'import', 'default']
}

function workbenchCustomConditions(
	packageMode: WorkbenchViteBuildOptions['packageMode'],
): string[] {
	return packageMode === 'development'
		? ['@pluxel/hmr', '@pluxel/source', 'development']
		: ['production']
}

function enableFederationInTestEnvironment(): () => void {
	const isTestEnvironment =
		Reflect.get(process.env, 'NODE_ENV') === 'test' ||
		process.env.VITEST !== undefined ||
		process.env.JEST_WORKER_ID !== undefined
	if (!isTestEnvironment) return () => undefined
	if (activeFederationTestBuilds === 0) {
		previousTestEnvironmentOverride = process.env.MFE_VITE_NO_TEST_ENV_CHECK
		process.env.MFE_VITE_NO_TEST_ENV_CHECK = 'true'
	}
	activeFederationTestBuilds += 1
	let active = true
	return () => {
		if (!active) return
		active = false
		activeFederationTestBuilds -= 1
		if (activeFederationTestBuilds > 0) return
		if (previousTestEnvironmentOverride === undefined) {
			delete process.env.MFE_VITE_NO_TEST_ENV_CHECK
		} else {
			process.env.MFE_VITE_NO_TEST_ENV_CHECK = previousTestEnvironmentOverride
		}
		previousTestEnvironmentOverride = undefined
	}
}

async function writeDtsTsConfig(options: WorkbenchViteBuildOptions): Promise<string> {
	const path = resolve(options.cacheDir, 'workbench-dts.tsconfig.json')
	// MF resolves TypeScript and writes its temporary configs beneath dts.cwd. Keep both inside the
	// build cache while linking the compiler owned by this package.
	const nodeModulesDir = resolve(options.cacheDir, 'node_modules')
	await mkdir(nodeModulesDir, { recursive: true })
	await rm(resolve(nodeModulesDir, 'typescript'), { recursive: true, force: true })
	await symlink(
		toolchainTypeScriptRoot,
		resolve(nodeModulesDir, 'typescript'),
		process.platform === 'win32' ? 'junction' : 'dir',
	)
	await writeFile(
		path,
		`${JSON.stringify({
			extends: resolve(options.producerRoot, 'tsconfig.json'),
			compilerOptions: {
				allowImportingTsExtensions: true,
				// TypeScript 7 requires an emit-safe companion for .ts imports. DTS generation must
				// rewrite those specifiers instead of carrying source-only extensions into consumers.
				rewriteRelativeImportExtensions: true,
				// Declaration generation must follow the same package graph as Vite. Otherwise a
				// development renderer can bundle source JS while declarations resolve stale dist.
				customConditions: workbenchCustomConditions(options.packageMode),
				lib: ['ES2024', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
				// The Vite application may be a nested host directory while producers live in sibling
				// workspace packages. Declarations therefore use their smallest common root.
				rootDir: options.declarationRoot,
				// MF DTS otherwise gives every producer under one application the same
				// node_modules/.cache/mf-types/.tsbuildinfo and races concurrent builds.
				tsBuildInfoFile: resolve(options.cacheDir, 'workbench.tsbuildinfo'),
			},
		})}\n`,
		'utf-8',
	)
	return path
}

function createPlugins(
	options: WorkbenchViteBuildOptions,
	dtsTsConfigPath: string | null,
): PluginOption[] {
	const [declareFullSharedSurface, removeSharedSurfaceDeclaration] =
		fullSharedSurfaceAnalysisPlugins(options)
	const plugins: PluginOption[] = [
		rejectHostOwnedMantineStyles(),
		declareFullSharedSurface,
		PreprocessorDirectives(),
	]
	if (options.paraglide) {
		plugins.push(
			paraglideVitePlugin({
				project: options.paraglide.project,
				outdir: options.paraglide.outdir,
			}),
		)
	}
	plugins.push(
		federation({
			name: options.producer,
			filename: WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE,
			exposes: options.exposes,
			manifest: { fileName: WORKBENCH_FEDERATION_MANIFEST_FILE },
			dts:
				options.typeAssets === 'required'
					? {
							cwd: options.cacheDir,
							consumeTypes: false,
							tsConfigPath: dtsTsConfigPath!,
							generateTypes: {
								abortOnError: true,
								compileInChildProcess: false,
								generateAPITypes: true,
							},
						}
					: false,
			publicPath: 'auto',
			shared: options.shared,
			shareStrategy: WORKBENCH_FEDERATION_SHARE_STRATEGY,
		}),
		removeSharedSurfaceDeclaration,
	)
	return plugins
}

function fullSharedSurfaceAnalysisPlugins(
	options: WorkbenchViteBuildOptions,
): readonly [beforeFederation: Plugin, afterFederation: Plugin] {
	const exposeEntries = new Set(Object.values(options.exposes).map((entry) => resolve(entry)))
	const requests = Object.entries(options.shared ?? {})
		.filter(([, config]) => typeof config === 'object' && config?.import === false)
		.map(([request]) => request)
	const marker = '@pluxel-workbench-full-shared-surface'
	const declaration = requests
		.map((request) => `import ${JSON.stringify(request)} /* ${marker} */`)
		.join('\n')
	const prefix = declaration ? `${declaration}\n` : ''
	const isExposeEntry = (id: string) => exposeEntries.has(resolve(cleanModuleId(id)))
	return [
		{
			name: 'pluxel-workbench-declare-full-shared-surface',
			enforce: 'pre',
			transform(code, id) {
				if (!prefix || !isExposeEntry(id)) return undefined
				return { code: `${prefix}${code}`, map: null }
			},
		},
		{
			name: 'pluxel-workbench-remove-shared-surface-declarations',
			enforce: 'post',
			transform(code, id) {
				if (!prefix || !isExposeEntry(id) || !code.startsWith(prefix)) return undefined
				return { code: code.slice(prefix.length), map: null }
			},
		},
	]
}

function rejectHostOwnedMantineStyles(): Plugin {
	return {
		name: 'pluxel-workbench-host-owned-mantine-styles',
		enforce: 'pre',
		resolveId(source) {
			const request = cleanModuleId(source)
			if (
				request === '@mantine/core/styles.css' ||
				request === '@mantine/core/styles.layer.css' ||
				request.startsWith('@mantine/core/styles/')
			) {
				throw new Error(
					'[workbench-ui] Mantine core styles are provided once by the Workbench Shell; remove the remote stylesheet import',
				)
			}
		},
	}
}

function cleanModuleId(id: string): string {
	const suffix = id.search(/[?#]/u)
	return suffix < 0 ? id : id.slice(0, suffix)
}
