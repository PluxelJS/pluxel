import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import {
	EXTENSION_FEDERATION_EXPOSE,
	extensionFederationBuildOutDir,
	EXTENSION_FEDERATION_MANIFEST_FILE,
	EXTENSION_FEDERATION_REMOTE_ENTRY_FILE,
	EXTENSION_FEDERATION_SHARE_STRATEGY,
	extensionFederationRemoteName,
	extensionFederationSharedPackages,
} from '@pluxel/core/federation'
import { resolve } from 'pathe'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { federation, type ModuleFederationOptions } from '@module-federation/vite'
import { build, type InlineConfig, mergeConfig, type Plugin, type PluginOption } from 'vite'
import { resolveParaglideIntegration } from './paraglide'

export type BuildPluginUiRemoteOptions = {
	pluginName: string
	entryPath: string
	root?: string
	outDir?: string
	sharedPackages?: readonly string[]
	minify?: boolean
	publicPath?: string
	/** Extra Vite config merged into this plugin UI remote build. */
	vite?: InlineConfig
}

export type ResolvedFederationShared = {
	shared: ModuleFederationOptions['shared']
	signature: string
	resolveRoot: string
}

type SerializedParaglideConfig = {
	project: string
	outdir: string
}

type PluginUiBuildPayload = {
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

const rootBuildTails = new Map<string, Promise<void>>()
const inflightBuilds = new Map<string, Promise<{ outDir: string; manifestPath: string }>>()
const MFE_VITE_NO_TEST_ENV_CHECK = 'true'

export async function buildPluginUiRemote(
	options: BuildPluginUiRemoteOptions,
): Promise<{ outDir: string; manifestPath: string }> {
	const root = resolve(options.root ?? process.cwd())
	const outDir = resolve(root, options.outDir ?? extensionFederationBuildOutDir())
	const entryPath = resolve(root, options.entryPath)
	const remoteName = extensionFederationRemoteName(options.pluginName)
	const sharedPackages = options.sharedPackages?.length
		? options.sharedPackages
		: extensionFederationSharedPackages
	const publicPath = options.publicPath ?? '/'
	const resolvedShared = resolveExtensionFederationShared(root, sharedPackages)
	const paraglide = resolveParaglideIntegration(root)
	const buildSignature = resolvePluginUiBuildSignature(options.vite)
	const result = {
		outDir,
		manifestPath: resolve(outDir, EXTENSION_FEDERATION_MANIFEST_FILE),
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

	const task = (async () => {
		const buildId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
		await runRootBuild(root, {
			root,
			outDir,
			entryPath,
			remoteName,
			cacheDir: resolve(root, '.pluxel/vite-plugin-ui-cache', `${remoteName}-${buildId}`),
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
		})
		return result
	})()

	inflightBuilds.set(buildKey, task)
	return task.finally(() => {
		if (inflightBuilds.get(buildKey) === task) {
			inflightBuilds.delete(buildKey)
		}
	})
}

export function disposePluginUiBuildSchedulers(): void {
	rootBuildTails.clear()
	inflightBuilds.clear()
}

function runRootBuild(root: string, payload: PluginUiBuildPayload): Promise<void> {
	const normalizedRoot = resolve(root)
	const previous = rootBuildTails.get(normalizedRoot) ?? Promise.resolve()
	const task = previous.catch((): void => undefined).then(() => runViteBuild(payload))
	rootBuildTails.set(normalizedRoot, task)
	return task.finally(() => {
		if (rootBuildTails.get(normalizedRoot) === task) {
			rootBuildTails.delete(normalizedRoot)
		}
	})
}

function isTestLikeProcessEnv(env: NodeJS.ProcessEnv): boolean {
	return (
		env.NODE_ENV === 'test' ||
		(env.VITEST !== null && env.VITEST !== undefined) ||
		(env.JEST_WORKER_ID !== null && env.JEST_WORKER_ID !== undefined)
	)
}

async function runViteBuild(payload: PluginUiBuildPayload): Promise<void> {
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
		plugins: createPluginUiBuildPlugins(payload),
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

function createPluginUiBuildPlugins(payload: PluginUiBuildPayload): PluginOption[] {
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
	return plugins
}

function createFederationPlugin(payload: PluginUiBuildPayload): PluginOption[] {
	const create = () =>
		toPluginArray(
			federation({
				name: payload.remoteName,
				filename: EXTENSION_FEDERATION_REMOTE_ENTRY_FILE,
				exposes: {
					[EXTENSION_FEDERATION_EXPOSE]: payload.entryPath,
				},
				manifest: {
					fileName: EXTENSION_FEDERATION_MANIFEST_FILE,
				},
				dts: false,
				publicPath: payload.publicPath,
				shared: payload.shared,
				shareStrategy: EXTENSION_FEDERATION_SHARE_STRATEGY,
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

function collectPluginNames(input: PluginOption | undefined, out: string[]): void {
	if (!input) return
	if (Array.isArray(input)) {
		for (const item of input) collectPluginNames(item, out)
		return
	}
	const plugin = input as Plugin
	if (typeof plugin.name === 'string' && plugin.name.length > 0) out.push(plugin.name)
	else out.push('anonymous')
}

export function resolvePluginUiBuildSignature(
	vite: InlineConfig | undefined,
): string {
	const pluginNames: string[] = []
	collectPluginNames(vite?.plugins, pluginNames)

	return [
		pluginNames.length > 0 ? `plugins:${pluginNames.join('|')}` : '',
		vite?.resolve ? `resolve:${stableJsonish(vite.resolve)}` : '',
		vite?.define ? `define:${stableJsonish(vite.define)}` : '',
		vite?.build ? `build:${stableJsonish(vite.build)}` : '',
		vite?.css ? `css:${stableJsonish(vite.css)}` : '',
	]
		.filter(Boolean)
		.join('\n')
}

function stableJsonish(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'function') return `[function ${(value as Function).name || 'anonymous'}]`
	if (value instanceof RegExp) return value.toString()
	if (Array.isArray(value)) return `[${value.map((item) => stableJsonish(item)).join(',')}]`
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a.localeCompare(b),
		)
		return `{${entries.map(([key, item]) => `${key}:${stableJsonish(item)}`).join(',')}}`
	}
	return JSON.stringify(value)
}

export function resolveExtensionFederationShared(
	root: string,
	sharedPackages: readonly string[],
): ResolvedFederationShared {
	const resolveRoot = findWorkspaceRoot(root) ?? root
	const specs = sharedPackages.map((pkg) => ({
		packageName: pkg,
		version: resolveSharedPackageVersion(resolveRoot, pkg),
	}))
	const signature = specs.map((spec) => `${spec.packageName}@${spec.version ?? '*'}`).join('|')
	const shared = Object.fromEntries(
		specs.map((spec) => [
			spec.packageName,
			{
				version: spec.version,
				singleton: true,
				import: false as const,
				requiredVersion: false as const,
			},
		]),
	) as unknown as ModuleFederationOptions['shared']

	return { shared, signature, resolveRoot }
}

function resolveSharedPackageVersion(root: string, packageName: string): string | undefined {
	const packageJsonPath = resolvePackageJsonPath(root, packageName)
	if (!packageJsonPath) return undefined

	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown }
		return typeof parsed.version === 'string' ? parsed.version : undefined
	} catch {
		return undefined
	}
}

function resolvePackageJsonPath(root: string, packageName: string): string | null {
	const req = createRequire(resolve(root, '__pluxel_mf_resolver__.mjs'))

	try {
		return req.resolve(`${packageName}/package.json`)
	} catch {
		// Fall through to package entry probing.
	}

	const resolvedEntry = resolvePackageEntry(root, packageName)
	if (!resolvedEntry) return null

	let current = existsSync(resolvedEntry) ? resolvedEntry : resolve(root, resolvedEntry)
	for (let depth = 0; depth < 8; depth += 1) {
		const candidate =
			current.endsWith('/package.json') || current.endsWith('\\package.json')
				? current
				: resolve(current, '..', 'package.json')
		if (existsSync(candidate)) {
			try {
				const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: unknown }
				if (parsed?.name === packageName) return candidate
			} catch {
				// Ignore invalid JSON and keep walking upward.
			}
		}

		const parent = resolve(current, '..')
		if (parent === current) break
		current = parent
	}

	return null
}

function resolvePackageEntry(root: string, packageName: string): string | null {
	try {
		const req = createRequire(resolve(root, '__pluxel_mf_resolver__.mjs'))
		return req.resolve(packageName)
	} catch {
		return null
	}
}

function findWorkspaceRoot(start: string): string | null {
	let current = start
	for (let depth = 0; depth < 12; depth += 1) {
		if (
			existsSync(resolve(current, 'pnpm-workspace.yaml')) ||
			existsSync(resolve(current, 'pnpm-lock.yaml'))
		) {
			return current
		}
		const parent = resolve(current, '..')
		if (parent === current) break
		current = parent
	}
	return null
}
