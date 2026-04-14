import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
	EXTENSION_FEDERATION_EXPOSE,
	extensionFederationBuildOutDir,
	EXTENSION_FEDERATION_MANIFEST_FILE,
	EXTENSION_FEDERATION_REMOTE_ENTRY_FILE,
	EXTENSION_FEDERATION_SHARE_STRATEGY,
	extensionFederationRemoteName,
	extensionFederationSharedPackages,
} from '@pluxel/runtime/web/federation'
import { resolve } from 'pathe'
import type { ModuleFederationOptions } from '@module-federation/vite'
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

type SerializedParaglideConfig = {
	project: string
	outdir: string
}

type PluginUiBuildChildPayload = {
	root: string
	outDir: string
	entryPath: string
	remoteName: string
	cacheDir: string
	shared: ModuleFederationOptions['shared']
	publicPath: string
	minify: boolean
	paraglide: SerializedParaglideConfig | null
	imports: {
		vite: string
		federation: string
		paraglide: string
	}
}

const rootBuildSchedulers = new Map<string, RootBuildScheduler>()
const inflightBuilds = new Map<string, Promise<{ outDir: string; manifestPath: string }>>()
const runtimeRequire = createRequire(import.meta.url)
const MFE_VITE_NO_TEST_ENV_CHECK = 'true'
const nodeExecutable = resolveNodeExecutable()
const shouldDisableFederationTestEnvCheck = isTestLikeProcessEnv(process.env)
let cleanupHooksRegistered = false

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
	].join('\u0000')
	const existing = inflightBuilds.get(buildKey)
	if (existing) return existing

	const task = (async () => {
		const buildId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
		await getRootBuildScheduler(root).runBuild({
			root,
			outDir,
			entryPath,
			remoteName,
			cacheDir: resolve(root, '.pluxel/vite-plugin-ui-cache', `${remoteName}-${buildId}`),
			shared: resolvedShared.shared,
			publicPath,
			minify: options.minify ?? true,
			paraglide: paraglide
				? {
						project: paraglide.project,
						outdir: paraglide.outdir,
					}
				: null,
			imports: {
				vite: pathToFileURL(runtimeRequire.resolve('vite')).href,
				federation: pathToFileURL(runtimeRequire.resolve('@module-federation/vite')).href,
				paraglide: pathToFileURL(runtimeRequire.resolve('@inlang/paraglide-js')).href,
			},
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
	for (const scheduler of rootBuildSchedulers.values()) {
		scheduler.close()
	}
	rootBuildSchedulers.clear()
	inflightBuilds.clear()
}

function getRootBuildScheduler(root: string): RootBuildScheduler {
	const normalizedRoot = resolve(root)
	let scheduler = rootBuildSchedulers.get(normalizedRoot)
	if (!scheduler) {
		registerCleanupHooks()
		scheduler = new RootBuildScheduler(normalizedRoot)
		rootBuildSchedulers.set(normalizedRoot, scheduler)
	}
	return scheduler
}

function registerCleanupHooks(): void {
	if (cleanupHooksRegistered) return
	cleanupHooksRegistered = true
	const dispose = () => disposePluginUiBuildSchedulers()
	process.once('exit', dispose)
	process.once('beforeExit', dispose)
}

function resolveNodeExecutable(): string {
	const explicit = process.env.PLUXEL_NODE_EXEC_PATH
	if (typeof explicit === 'string' && existsSync(explicit)) return explicit

	if (existsSync(process.execPath)) return process.execPath
	return 'node'
}

function isTestLikeProcessEnv(env: NodeJS.ProcessEnv): boolean {
	return (
		env.NODE_ENV === 'test' ||
		(env.VITEST !== null && env.VITEST !== undefined) ||
		(env.JEST_WORKER_ID !== null && env.JEST_WORKER_ID !== undefined)
	)
}

class RootBuildScheduler {
	private readonly root: string
	private tail: Promise<void> = Promise.resolve()
	private activeChild: ChildProcessWithoutNullStreams | null = null
	private pendingCount = 0
	private closed = false

	constructor(root: string) {
		this.root = root
	}

	runBuild(payload: PluginUiBuildChildPayload): Promise<void> {
		if (this.closed) {
			throw new Error(`Plugin UI build scheduler already closed for ${this.root}`)
		}
		this.pendingCount += 1
		const task = this.tail.catch((): void => undefined).then(() => this.spawnIsolatedBuild(payload))
		this.tail = task.finally(() => {
			this.pendingCount -= 1
			if (
				this.pendingCount === 0 &&
				!this.activeChild &&
				rootBuildSchedulers.get(this.root) === this
			) {
				rootBuildSchedulers.delete(this.root)
			}
		})
		return task
	}

	close(): void {
		this.closed = true
		const child = this.activeChild
		this.activeChild = null
		if (child && !child.killed) {
			child.kill()
		}
		if (rootBuildSchedulers.get(this.root) === this) {
			rootBuildSchedulers.delete(this.root)
		}
	}

	private async spawnIsolatedBuild(payload: PluginUiBuildChildPayload): Promise<void> {
		if (this.closed) {
			throw new Error(`Plugin UI build scheduler already closed for ${this.root}`)
		}

		const child = spawn(
			nodeExecutable,
			['--input-type=module', '--eval', PLUGIN_UI_BUILD_CHILD_SCRIPT],
			{
				cwd: this.root,
				env: {
					...process.env,
					...(shouldDisableFederationTestEnvCheck ? { MFE_VITE_NO_TEST_ENV_CHECK } : {}),
					PLUXEL_PLUGIN_UI_BUILD_PAYLOAD: JSON.stringify(payload),
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)
		this.activeChild = child

		const stdoutLines: string[] = []
		const stderrLines: string[] = []
		child.stdout.on('data', (chunk) => {
			this.pushOutput(stdoutLines, chunk)
		})
		child.stderr.on('data', (chunk) => {
			this.pushOutput(stderrLines, chunk)
		})

		await new Promise<void>((resolvePromise, rejectPromise) => {
			let settled = false
			const settle = (callback: () => void) => {
				if (settled) return
				settled = true
				this.activeChild = null
				callback()
			}
			child.once('error', (error) => {
				settle(() => {
					rejectPromise(this.decorateChildError(error, stdoutLines, stderrLines))
				})
			})
			child.once('exit', (code, signal) => {
				settle(() => {
					if (code === 0) {
						resolvePromise()
						return
					}
					rejectPromise(
						this.decorateChildError(
							new Error(
								[
									`Plugin UI build failed for ${this.root}`,
									signal ? `signal: ${signal}` : `exit code: ${code ?? 'unknown'}`,
								].join('\n'),
							),
							stdoutLines,
							stderrLines,
						),
					)
				})
			})
		})
	}

	private decorateChildError(error: Error, stdoutLines: string[], stderrLines: string[]): Error {
		const details = [...stderrLines.slice(-40), ...stdoutLines.slice(-20)].join('\n').trim()
		if (!details) return error
		return new Error(`${error.message}\n${details}`)
	}

	private pushOutput(bucket: string[], chunk: unknown): void {
		const text = String(chunk ?? '')
		if (!text) return
		for (const line of text.split(/\r?\n/)) {
			if (!line) continue
			bucket.push(line)
			if (bucket.length > 120) bucket.shift()
		}
	}
}

const PLUGIN_UI_BUILD_CHILD_SCRIPT = `
import { rm } from 'node:fs/promises'
const toPluginArray = (input) => Array.isArray(input) ? input.flatMap((item) => toPluginArray(item)) : [input]
const cleanup = async (options) => rm(options.cacheDir, { recursive: true, force: true })

async function runBuild(options) {
	const { build } = await import(options.imports.vite)
	const { federation } = await import(options.imports.federation)
	const plugins = []
	if (options.paraglide) {
		const { paraglideVitePlugin } = await import(options.imports.paraglide)
		plugins.push(...toPluginArray(paraglideVitePlugin({
			project: options.paraglide.project,
			outdir: options.paraglide.outdir,
		})))
	}
	plugins.push(federation({
		name: options.remoteName,
		filename: ${JSON.stringify(EXTENSION_FEDERATION_REMOTE_ENTRY_FILE)},
		exposes: {
			[${JSON.stringify(EXTENSION_FEDERATION_EXPOSE)}]: options.entryPath,
		},
		manifest: {
			fileName: ${JSON.stringify(EXTENSION_FEDERATION_MANIFEST_FILE)},
		},
		dts: false,
		publicPath: options.publicPath,
		shared: options.shared,
		shareStrategy: ${JSON.stringify(EXTENSION_FEDERATION_SHARE_STRATEGY)},
	}))

	try {
		await build({
			configFile: false,
			root: options.root,
			cacheDir: options.cacheDir,
			publicDir: false,
			clearScreen: false,
			logLevel: 'error',
			resolve: {
				preserveSymlinks: false,
				tsconfigPaths: true,
			},
			plugins,
			build: {
				outDir: options.outDir,
				emptyOutDir: true,
				target: 'chrome89',
				manifest: false,
				minify: options.minify,
				cssCodeSplit: true,
				sourcemap: true,
				rollupOptions: {
					input: options.entryPath,
				},
			},
		})
	} catch (error) {
		await rm(options.outDir, { recursive: true, force: true })
		throw error
	} finally {
		await cleanup(options)
	}
}

const payload = process.env.PLUXEL_PLUGIN_UI_BUILD_PAYLOAD
if (!payload) {
	console.error('Missing PLUXEL_PLUGIN_UI_BUILD_PAYLOAD')
	process.exit(1)
}

try {
	await runBuild(JSON.parse(payload))
	process.exit(0)
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : String(error))
	process.exit(1)
}
`

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
