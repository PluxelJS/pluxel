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

export type WorkbenchUiWorkerPayload = Readonly<{
	root: string
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
	process.env.MFE_VITE_NO_TEST_ENV_CHECK = 'true'
	try {
		const dtsTsConfigPath = await writeDtsTsConfig(payload)
		const config: InlineConfig = {
			configFile: false,
			root: payload.root,
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
		await rm(payload.cacheDir, { recursive: true, force: true })
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
				lib: ['ES2024', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
			},
		})}\n`,
		'utf-8',
	)
	return path
}

function createPlugins(payload: WorkbenchUiWorkerPayload, dtsTsConfigPath: string): PluginOption[] {
	const plugins: PluginOption[] = [PreprocessorDirectives()]
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
	)
	return plugins
}

function toPluginArray(input: unknown): PluginOption[] {
	if (Array.isArray(input)) return input.flatMap((item) => toPluginArray(item))
	if (!input) return []
	return [input as PluginOption]
}
