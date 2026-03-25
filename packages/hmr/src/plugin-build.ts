import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import Module, { createRequire } from 'node:module'
import {
	EXTENSION_FEDERATION_EXPOSE,
	extensionFederationBuildOutDir,
	EXTENSION_FEDERATION_MANIFEST_FILE,
	EXTENSION_FEDERATION_REMOTE_ENTRY_FILE,
	EXTENSION_FEDERATION_SHARE_STRATEGY,
	extensionFederationRemoteName,
	extensionFederationSharedPackages,
	sanitizeExtensionPluginName,
} from '@pluxel/runtime/web/federation'
import { resolve } from 'pathe'
import { build, type InlineConfig } from 'vite'
import { federation, type ModuleFederationOptions } from '@module-federation/vite'
import { resolveParaglideIntegration } from './paraglide'

export type BuildPluginUiRemoteOptions = {
	pluginName: string
	entryPath: string
	root?: string
	outDir?: string
	sharedPackages?: readonly string[]
	minify?: boolean
	publicPath?: string
}

export type ResolvedFederationShared = {
	shared: ModuleFederationOptions['shared']
	signature: string
	resolveRoot: string
}

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
	const sharedResolveRoot = resolvedShared.resolveRoot
	const shared = resolvedShared.shared
	const paraglide = resolveParaglideIntegration(root)

	const config: InlineConfig = {
		configFile: false,
		root,
		publicDir: false,
		clearScreen: false,
		logLevel: 'error',
		resolve: {
			preserveSymlinks: false,
			tsconfigPaths: true,
		} as InlineConfig['resolve'],
		plugins: [
			...(paraglide?.plugins ?? []),
			federation({
				name: remoteName,
				filename: EXTENSION_FEDERATION_REMOTE_ENTRY_FILE,
				exposes: {
					[EXTENSION_FEDERATION_EXPOSE]: entryPath,
				},
				manifest: {
					fileName: EXTENSION_FEDERATION_MANIFEST_FILE,
				},
				dts: false,
				publicPath,
				shared,
				shareStrategy: EXTENSION_FEDERATION_SHARE_STRATEGY,
			}),
		],
		build: {
			outDir,
			emptyOutDir: true,
			target: 'chrome89',
			manifest: false,
			minify: options.minify ?? true,
			cssCodeSplit: true,
			sourcemap: true,
			rollupOptions: {
				input: entryPath,
			},
		},
	}

	await cleanupFederationTempArtifacts(root)
	try {
		await withPatchedPackageJsonResolution(sharedResolveRoot, sharedPackages, async () => {
			const previousCwd = process.cwd()
			process.chdir(root)
			try {
				return await build(config)
			} finally {
				process.chdir(previousCwd)
			}
		})
	} finally {
		await cleanupFederationTempArtifacts(root)
	}

	return {
		outDir,
		manifestPath: resolve(outDir, EXTENSION_FEDERATION_MANIFEST_FILE),
	}
}

async function cleanupFederationTempArtifacts(root: string): Promise<void> {
	await Promise.all([
		rm(resolve(root, 'node_modules/__mf__virtual'), { recursive: true, force: true }),
		rm(resolve(root, '.__mf__temp'), { recursive: true, force: true }),
	])
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

async function withPatchedPackageJsonResolution<T>(
	root: string,
	sharedPackages: readonly string[],
	run: () => Promise<T>,
): Promise<T> {
	const moduleLoader = Module as typeof Module & {
		_resolveFilename?: (...args: unknown[]) => string
	}
	const originalResolveFilename = moduleLoader._resolveFilename
	if (!originalResolveFilename) return run()

	const patchedPackages = new Set(sharedPackages.map(removePathFromNpmPackage))

	moduleLoader._resolveFilename = function patchedResolveFilename(...args: unknown[]): string {
		const [request] = args
		if (typeof request === 'string' && request.endsWith('/package.json')) {
			const packageName = request.slice(0, -'/package.json'.length)
			if (patchedPackages.has(packageName)) {
				const resolved = resolvePackageJsonPath(root, packageName)
				if (resolved) return resolved
			}
		}
		return originalResolveFilename.apply(this, args)
	}

	try {
		return await run()
	} finally {
		moduleLoader._resolveFilename = originalResolveFilename
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

function removePathFromNpmPackage(input: string): string {
	if (!input.startsWith('@')) {
		const [name] = input.split('/')
		return name || input
	}

	const [scope, name] = input.split('/')
	return scope && name ? `${scope}/${name}` : input
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
