import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import {
	MANAGEMENT_FEDERATION_EXPOSE,
	managementFederationBuildOutDir,
	MANAGEMENT_FEDERATION_MANIFEST_FILE,
	MANAGEMENT_FEDERATION_REMOTE_ENTRY_FILE,
	MANAGEMENT_FEDERATION_SHARE_STRATEGY,
	managementFederationRemoteName,
	managementFederationSharedPackages,
} from '@pluxel/core/federation'
import { resolve } from 'pathe'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { federation, type ModuleFederationOptions } from '@module-federation/vite'
import { build, type InlineConfig, mergeConfig, type Plugin, type PluginOption } from 'vite'
import {
	resolveManagementFederationShared,
	resolveManagementUiBuildSignature,
} from '../management/build-contract.ts'
import {
	runManagementFederationBuild,
	runManagementOutputTransaction,
} from '../management/build-scheduler.ts'
import { resolveParaglideIntegration } from './paraglide.ts'
import { validateManagementUiArtifact } from '../management/artifact.ts'

export type BuildManagementUiRemoteOptions = {
	pluginName: string
	entryPath: string
	root?: string
	outDir?: string
	sharedPackages?: readonly string[]
	minify?: boolean
	publicPath?: string
	/** Extra Vite config merged into this management UI remote build. */
	vite?: InlineConfig
	/** Explicitly invalidates caches when a user Vite plugin changes behavior or options. */
	cacheKey?: string
}

export {
	resolveManagementFederationShared,
	resolveManagementUiBuildSignature,
	type ResolvedFederationShared,
} from '../management/build-contract.ts'

type SerializedParaglideConfig = {
	project: string
	outdir: string
}

type ManagementUiBuildPayload = {
	root: string
	outDir: string
	entryPath: string
	remoteName: string
	cacheDir: string
	shared: ModuleFederationOptions['shared']
	publicPath: string
	minify: boolean
	paraglide: SerializedParaglideConfig | null
	vite?: InlineConfig
}

const inflightBuilds = new Map<string, Promise<{ outDir: string; manifestPath: string }>>()
const MFE_VITE_NO_TEST_ENV_CHECK = 'true'

export async function buildManagementUiRemote(
	options: BuildManagementUiRemoteOptions,
): Promise<{ outDir: string; manifestPath: string }> {
	const root = resolve(options.root ?? process.cwd())
	const outDir = resolve(
		root,
		options.outDir ?? managementFederationBuildOutDir(options.pluginName),
	)
	const entryPath = resolve(root, options.entryPath)
	const remoteName = managementFederationRemoteName(options.pluginName)
	const sharedPackages = options.sharedPackages?.length
		? options.sharedPackages
		: managementFederationSharedPackages
	const publicPath = options.publicPath ?? '/'
	const resolvedShared = resolveManagementFederationShared(root, sharedPackages)
	const paraglide = resolveParaglideIntegration(root)
	const buildSignature = resolveManagementUiBuildSignature(options.vite, options.cacheKey)
	const result = {
		outDir,
		manifestPath: resolve(outDir, MANAGEMENT_FEDERATION_MANIFEST_FILE),
	}

	const buildKey = [
		root,
		outDir,
		entryPath,
		remoteName,
		resolvedShared.signature,
		publicPath,
		String(options.minify ?? true),
		paraglide?.project ?? '',
		paraglide?.outdir ?? '',
		buildSignature,
	].join('\u0000')
	const existing = inflightBuilds.get(buildKey)
	if (existing) return existing

	const task = runManagementOutputTransaction(outDir, async () => {
		const buildId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
		const stagedOutDir = `${outDir}.tmp-${buildId}`
		await rm(stagedOutDir, { recursive: true, force: true })
		try {
			await runManagementFederationBuild(() =>
				runViteBuild({
					root,
					outDir: stagedOutDir,
					entryPath,
					remoteName,
					cacheDir: resolve(root, '.pluxel/vite-management-ui-cache', `${remoteName}-${buildId}`),
					shared: resolvedShared.shared,
					publicPath,
					minify: options.minify ?? true,
					vite: options.vite,
					paraglide: paraglide
						? {
								project: paraglide.project,
								outdir: paraglide.outdir,
							}
						: null,
				}),
			)
			const stagedManifest = resolve(stagedOutDir, MANAGEMENT_FEDERATION_MANIFEST_FILE)
			await disableExposedEntryPreloads(stagedManifest)
			const validation = await validateManagementUiArtifact(stagedOutDir, options.pluginName)
			if (!validation.valid) {
				throw new Error(
					`[management-ui] incomplete federation artifact: ${'reason' in validation ? validation.reason : 'unknown validation failure'}`,
				)
			}
			await publishDirectory(stagedOutDir, outDir, buildId)
		} catch (error) {
			await rm(stagedOutDir, { recursive: true, force: true })
			throw error
		}
	})

	const resultTask = task.then(() => result)
	inflightBuilds.set(buildKey, resultTask)
	return resultTask.finally(() => {
		if (inflightBuilds.get(buildKey) === resultTask) {
			inflightBuilds.delete(buildKey)
		}
	})
}

async function publishDirectory(staged: string, target: string, buildId: string): Promise<void> {
	const previous = `${target}.previous-${buildId}`
	await rm(previous, { recursive: true, force: true })
	let movedPrevious = false
	try {
		await rename(target, previous)
		movedPrevious = true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	try {
		await rename(staged, target)
	} catch (error) {
		if (movedPrevious) await rename(previous, target).catch((): undefined => undefined)
		throw error
	}
	if (movedPrevious) await rm(previous, { recursive: true, force: true })
}

function isTestLikeProcessEnv(env: NodeJS.ProcessEnv): boolean {
	return (
		env.NODE_ENV === 'test' ||
		(env.VITEST !== null && env.VITEST !== undefined) ||
		(env.JEST_WORKER_ID !== null && env.JEST_WORKER_ID !== undefined)
	)
}

async function runViteBuild(payload: ManagementUiBuildPayload): Promise<void> {
	const internalConfig: InlineConfig = {
		configFile: false,
		root: payload.root,
		cacheDir: payload.cacheDir,
		publicDir: false,
		clearScreen: false,
		logLevel: 'error',
		resolve: {
			preserveSymlinks: false,
			tsconfigPaths: true,
		},
		plugins: createManagementUiBuildPlugins(payload),
		build: {
			outDir: payload.outDir,
			emptyOutDir: true,
			target: 'chrome89',
			manifest: false,
			minify: payload.minify,
			cssCodeSplit: true,
			sourcemap: true,
			rollupOptions: {
				input: payload.entryPath,
			},
		},
	}
	try {
		await build(mergeConfig(internalConfig, payload.vite ?? {}))
	} catch (error) {
		await rm(payload.outDir, { recursive: true, force: true })
		throw error
	} finally {
		await rm(payload.cacheDir, { recursive: true, force: true })
	}
}

function createManagementUiBuildPlugins(payload: ManagementUiBuildPayload): PluginOption[] {
	const plugins: PluginOption[] = []
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
	plugins.push(...createFederationPlugin(payload))
	plugins.push(createAwaitRemoteInitPlugin(payload.remoteName))
	return plugins
}

function createFederationPlugin(payload: ManagementUiBuildPayload): PluginOption[] {
	const create = () =>
		toPluginArray(
			federation({
				name: payload.remoteName,
				filename: MANAGEMENT_FEDERATION_REMOTE_ENTRY_FILE,
				exposes: {
					[MANAGEMENT_FEDERATION_EXPOSE]: payload.entryPath,
				},
				manifest: {
					fileName: MANAGEMENT_FEDERATION_MANIFEST_FILE,
				},
				dts: false,
				publicPath: payload.publicPath,
				shared: payload.shared,
				shareStrategy: MANAGEMENT_FEDERATION_SHARE_STRATEGY,
			}),
		)

	if (!isTestLikeProcessEnv(process.env)) return create()

	// @module-federation/vite intentionally skips itself under test runners unless this is set.
	const previous = process.env.MFE_VITE_NO_TEST_ENV_CHECK
	process.env.MFE_VITE_NO_TEST_ENV_CHECK = MFE_VITE_NO_TEST_ENV_CHECK
	try {
		return create()
	} finally {
		if (previous === undefined) {
			delete process.env.MFE_VITE_NO_TEST_ENV_CHECK
		} else {
			process.env.MFE_VITE_NO_TEST_ENV_CHECK = previous
		}
	}
}

function toPluginArray(input: PluginOption | undefined): PluginOption[] {
	if (Array.isArray(input)) return input.flatMap((item) => toPluginArray(item))
	if (!input) return []
	return [input]
}

function createAwaitRemoteInitPlugin(remoteName: string): Plugin {
	const initGlobalKey = `__mf_init__virtual:mf:__mfe_internal__${remoteName}__mf_v__runtimeInit__mf_v__.js__`

	return {
		name: 'pluxel-management-ui-await-remote-init',
		enforce: 'post',
		transform(code, id) {
			if (!id.includes('virtual:mf-exposes:')) return null
			if (id.includes('virtual:mf-exposes-ssr:')) return null
			if (code.includes('__pluxelMfRemoteInitPromise')) return null

			const marker = 'await injectCssAssets('
			if (!code.includes(marker)) return null

			const awaitRemoteInit = [
				`const __pluxelMfRemoteInitState = globalThis[${JSON.stringify(initGlobalKey)}];`,
				'const __pluxelMfRemoteInitPromise = __pluxelMfRemoteInitState?.initPromise ?? Promise.resolve();',
			].join('\n')

			return [
				awaitRemoteInit,
				code.replaceAll(
					marker,
					'await __pluxelMfRemoteInitPromise;\n          await injectCssAssets(',
				),
			].join('\n')
		},
	}
}

async function disableExposedEntryPreloads(manifestPath: string): Promise<void> {
	type FederationManifest = {
		exposes?: Array<{
			assets?: {
				js?: {
					async?: string[]
					sync?: string[]
				}
			}
		}>
	}

	const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as FederationManifest
	let changed = false

	for (const expose of manifest.exposes ?? []) {
		const jsAssets = expose.assets?.js
		if (!jsAssets) continue
		if ((jsAssets.async?.length ?? 0) > 0) {
			jsAssets.async = []
			changed = true
		}
		if ((jsAssets.sync?.length ?? 0) > 0) {
			jsAssets.sync = []
			changed = true
		}
	}

	if (changed) {
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf-8')
	}
}
