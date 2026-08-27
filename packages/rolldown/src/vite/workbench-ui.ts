import { rename, rm } from 'node:fs/promises'
import {
	WORKBENCH_FEDERATION_EXPOSE,
	workbenchFederationBuildOutDir,
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE,
	WORKBENCH_FEDERATION_SHARE_STRATEGY,
	workbenchFederationRemoteName,
} from '@pluxel/core/federation'
import { resolve } from 'pathe'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { federation, type ModuleFederationOptions } from '@module-federation/vite'
import { build, type InlineConfig, type PluginOption } from 'vite'
import { resolveWorkbenchFederationShared } from '../workbench/build-contract.ts'
import {
	runWorkbenchFederationBuild,
	runWorkbenchOutputTransaction,
} from '../workbench/build-scheduler.ts'
import { resolveParaglideIntegration } from './paraglide.ts'
import { pluginSourceVitePlugins } from './plugin-source.ts'
import { validateWorkbenchUiArtifact } from '../workbench/artifact.ts'

export type BuildWorkbenchUiRemoteOptions = {
	pluginName: string
	entryPath: string
	root?: string
	outDir?: string
	minify?: boolean
	sourcemap?: boolean
	publicPath?: string
}

export {
	resolveWorkbenchFederationShared,
	type ResolvedFederationShared,
} from '../workbench/build-contract.ts'

type SerializedParaglideConfig = {
	project: string
	outdir: string
}

type WorkbenchUiBuildPayload = {
	root: string
	outDir: string
	entryPath: string
	remoteName: string
	cacheDir: string
	shared: ModuleFederationOptions['shared']
	publicPath: string
	minify: boolean
	sourcemap: boolean
	paraglide: SerializedParaglideConfig | null
}

const inflightBuilds = new Map<string, Promise<{ outDir: string; manifestPath: string }>>()
const MFE_VITE_NO_TEST_ENV_CHECK = 'true'

export async function buildWorkbenchUiRemote(
	options: BuildWorkbenchUiRemoteOptions,
): Promise<{ outDir: string; manifestPath: string }> {
	const root = resolve(options.root ?? process.cwd())
	const outDir = resolve(root, options.outDir ?? workbenchFederationBuildOutDir(options.pluginName))
	const entryPath = resolve(root, options.entryPath)
	const remoteName = workbenchFederationRemoteName(options.pluginName)
	const publicPath = options.publicPath ?? '/'
	const resolvedShared = resolveWorkbenchFederationShared(root)
	const paraglide = resolveParaglideIntegration(root)
	const result = {
		outDir,
		manifestPath: resolve(outDir, WORKBENCH_FEDERATION_MANIFEST_FILE),
	}

	const buildKey = [
		root,
		outDir,
		entryPath,
		remoteName,
		resolvedShared.signature,
		publicPath,
		String(options.minify ?? true),
		String(options.sourcemap ?? false),
		paraglide?.project ?? '',
		paraglide?.outdir ?? '',
	].join('\u0000')
	const existing = inflightBuilds.get(buildKey)
	if (existing) return existing

	const task = runWorkbenchOutputTransaction(outDir, async () => {
		const buildId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
		const stagedOutDir = `${outDir}.tmp-${buildId}`
		await rm(stagedOutDir, { recursive: true, force: true })
		try {
			await runWorkbenchFederationBuild(() =>
				runViteBuild({
					root,
					outDir: stagedOutDir,
					entryPath,
					remoteName,
					cacheDir: resolve(root, '.pluxel/vite-workbench-ui-cache', `${remoteName}-${buildId}`),
					shared: resolvedShared.shared,
					publicPath,
					minify: options.minify ?? true,
					sourcemap: options.sourcemap ?? false,
					paraglide: paraglide
						? {
								project: paraglide.project,
								outdir: paraglide.outdir,
							}
						: null,
				}),
			)
			const validation = await validateWorkbenchUiArtifact(stagedOutDir, options.pluginName)
			if (!validation.valid) {
				throw new Error(
					`[workbench-ui] incomplete federation artifact: ${'reason' in validation ? validation.reason : 'unknown validation failure'}`,
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

async function runViteBuild(payload: WorkbenchUiBuildPayload): Promise<void> {
	const buildConfig: InlineConfig = {
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
		plugins: createWorkbenchUiBuildPlugins(payload),
		build: {
			outDir: payload.outDir,
			emptyOutDir: true,
			target: 'chrome89',
			manifest: false,
			minify: payload.minify,
			cssCodeSplit: true,
			sourcemap: payload.sourcemap,
			rollupOptions: {
				input: payload.entryPath,
			},
		},
		server: { watch: null },
	}
	try {
		await build(buildConfig)
	} catch (error) {
		await rm(payload.outDir, { recursive: true, force: true })
		throw error
	} finally {
		await rm(payload.cacheDir, { recursive: true, force: true })
	}
}

function createWorkbenchUiBuildPlugins(payload: WorkbenchUiBuildPayload): PluginOption[] {
	const plugins: PluginOption[] = pluginSourceVitePlugins({
		root: payload.root,
		lintGuard: false,
		configSource: false,
	})
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
	return plugins
}

function createFederationPlugin(payload: WorkbenchUiBuildPayload): PluginOption[] {
	const create = () =>
		toPluginArray(
			federation({
				name: payload.remoteName,
				filename: WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE,
				exposes: {
					[WORKBENCH_FEDERATION_EXPOSE]: payload.entryPath,
				},
				manifest: {
					fileName: WORKBENCH_FEDERATION_MANIFEST_FILE,
				},
				dts: false,
				publicPath: payload.publicPath,
				shared: payload.shared,
				shareStrategy: WORKBENCH_FEDERATION_SHARE_STRATEGY,
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

function toPluginArray(input: unknown): PluginOption[] {
	if (Array.isArray(input)) return input.flatMap((item) => toPluginArray(item))
	if (!input) return []
	return [input as PluginOption]
}
