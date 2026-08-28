import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import {
	WORKBENCH_SHELL_BUILD_INFO_FILE,
	WORKBENCH_SHELL_BUILD_INFO_VERSION,
} from '@pluxel/core/federation'
import { FullTracePackages, NodeNativePackages, NonBundleablePackages } from 'nf3/db'
import type { ExternalsTraceOptions } from 'nf3'
import { dirname, isAbsolute, relative, resolve } from 'pathe'
import type { OutputBundle, OutputChunk, Plugin } from 'rolldown'
import type { UserConfig } from 'tsdown'
import { createDistributionManifest } from '../distribution'
import { staticConfigEnvironmentDeclarationPlugin } from '../rolldown/plugins/staticConfigEnvironmentPlugin'
import { runWorkbenchOutputTransaction } from '../workbench/build-scheduler'
import { createPluginBuildPipeline, type PluginBuildPipeline } from './plugin-build'
import { staticElysiaSingletonPlugin } from './elysia-singleton'
import { writeStaticConfigEnvironmentExample } from './static-config-environment-output'

export type StaticApplicationBuildOptions = {
	entry: string
	cwd?: string
	outDir?: string
	variant?: 'headless' | 'workbench'
	/** Runtime adapter emitted by the production bootstrap. @default 'node' */
	launcher?: 'node' | 'fetch'
	target?: 'node'
	/** Managed database drivers carried by this deployment. @default ['pglite', 'postgres'] */
	managedDatabaseDrivers?: readonly StaticApplicationManagedDatabaseDriver[]
	residualDependencies?: StaticApplicationResidualDependencies
	minify?: boolean
	sourcemap?: boolean
	/** Keep mappings and source paths without embedding full source text. @default false */
	sourcemapExcludeSources?: boolean
	lint?: boolean
}

export type StaticApplicationManagedDatabaseDriver = 'pglite' | 'postgres'

export type StaticApplicationResidualDependencies = {
	packages?: readonly string[]
	fullTrace?: readonly string[]
}

type StaticApplicationBuildState = {
	name?: string
	environmentExample?: string
	environmentExampleOwned: boolean
	residualPackages: string[]
}

type DeclaredWorkspacePackage = {
	name: string
	root: string
	version: string
	packageJson: Record<string, unknown>
}

type TracedPackages = Parameters<
	NonNullable<NonNullable<ExternalsTraceOptions['hooks']>['tracedPackages']>
>[0]
type TracedPackageVersion = TracedPackages[string]['versions'][string]

const ManagedDatabasePackages = {
	pglite: '@electric-sql/pglite',
	postgres: 'pg',
} as const satisfies Record<StaticApplicationManagedDatabaseDriver, string>
const ManagedDatabaseEntries = {
	pglite: '#pluxel/database-driver/pglite',
	postgres: '#pluxel/database-driver/postgres',
} as const satisfies Record<StaticApplicationManagedDatabaseDriver, string>
const ManagedDatabaseDrivers = Object.freeze(
	Object.keys(ManagedDatabasePackages) as StaticApplicationManagedDatabaseDriver[],
)
const RuntimeResidualPackages = Object.freeze(Object.values(ManagedDatabasePackages))
const RuntimeFullTracePackages = ['tslib', '@electric-sql/pglite'] as const
const OMITTED_MANAGED_DATABASE_PREFIX = '\0pluxel:omitted-managed-database:'
const STATIC_APPLICATION_BOOTSTRAP_ID = 'pluxel:static-application-bootstrap'
const RESOLVED_STATIC_APPLICATION_BOOTSTRAP_ID = `\0${STATIC_APPLICATION_BOOTSTRAP_ID}`

export function staticApplication(
	options: StaticApplicationBuildOptions,
): Omit<UserConfig, 'inputOptions'> & Pick<PluginBuildPipeline, 'inputOptions'> {
	const cwd = resolve(options.cwd ?? process.cwd())
	const entry = resolve(cwd, options.entry)
	const outDir = resolve(cwd, options.outDir ?? 'dist')
	const variant = options.variant ?? 'workbench'
	const launcher = String(options.launcher ?? 'node')
	if (launcher !== 'node' && launcher !== 'fetch') {
		throw new Error('[static-application] launcher must be either node or fetch')
	}
	const target = String(options.target ?? 'node')
	if (target !== 'node')
		throw new Error('[static-application] only the node target is currently supported')
	const managedDatabaseDrivers = resolveManagedDatabaseDrivers(options.managedDatabaseDrivers)
	const residualDependencies = resolveResidualDependencies(options.residualDependencies)
	const omittedManagedDatabaseDrivers = ManagedDatabaseDrivers.filter(
		(driver) => !managedDatabaseDrivers.includes(driver),
	)
	const state: StaticApplicationBuildState = {
		environmentExampleOwned: false,
		residualPackages: [],
	}
	const artifactNativeResiduals = new Map<string, Set<string>>()
	const buildDir = relative(cwd, outDir) || '.'
	const sourcePipeline = createPluginBuildPipeline({
		root: cwd,
		lint: options.lint,
		artifactBuildDir: buildDir,
		workbench: variant === 'workbench' ? { buildDir, minify: options.minify ?? true } : false,
		node: {
			minify: options.minify,
			onNativeResidualReset() {
				artifactNativeResiduals.clear()
			},
			onNativeResidual(name, resolvedEntry) {
				let entries = artifactNativeResiduals.get(name)
				if (!entries) {
					entries = new Set()
					artifactNativeResiduals.set(name, entries)
				}
				entries.add(resolvedEntry)
			},
		},
	})

	return {
		name: 'pluxel-static-application',
		cwd,
		entry: { app: STATIC_APPLICATION_BOOTSTRAP_ID },
		outDir,
		platform: 'node',
		target: 'node24',
		format: 'esm',
		fixedExtension: true,
		dts: false,
		clean: true,
		minify: options.minify ?? true,
		sourcemap: options.sourcemap ?? false,
		outputOptions: {
			sourcemapExcludeSources: options.sourcemapExcludeSources ?? false,
		},
		treeshake: true,
		hash: true,
		deps: {
			alwaysBundle: () => true,
			onlyBundle: false,
		},
		plugins: [
			staticConfigEnvironmentDeclarationPlugin({
				entry,
				onDeclaration(facts) {
					state.name = facts.name
					state.environmentExample = facts.environmentExample
				},
			}),
			staticElysiaSingletonPlugin(cwd),
			...(sourcePipeline.plugins ?? []),
			nf3ExternalsPlugin({
				cwd,
				outDir,
				include: [
					...NodeNativePackages,
					...NonBundleablePackages,
					...RuntimeResidualPackages,
					...residualDependencies.packages,
				],
				declaredPackages: residualDependencies.packages,
				declaredFullTracePackages: residualDependencies.fullTrace,
				omittedManagedDatabaseDrivers,
				conditions: ['node', 'import', 'default'],
				fullTraceInclude: [
					...FullTracePackages,
					...RuntimeFullTracePackages,
					...residualDependencies.fullTrace,
				],
				artifactNativeResiduals,
				onTracedPackages(packages) {
					state.residualPackages = Object.keys(packages).sort()
				},
			}),
			staticApplicationEntryPlugin({ entry, variant, launcher, state }),
			staticApplicationAssemblyPlugin({ cwd, outDir, variant, state }),
		],
		inputOptions: {
			...sourcePipeline.inputOptions,
			resolve: {
				conditionNames: ['@pluxel/source', 'node', 'import', 'module', 'production', 'default'],
			},
		},
	}
}

function nf3ExternalsPlugin(options: {
	cwd: string
	outDir: string
	include: readonly string[]
	declaredPackages: readonly string[]
	declaredFullTracePackages: readonly string[]
	omittedManagedDatabaseDrivers: readonly StaticApplicationManagedDatabaseDriver[]
	conditions: string[]
	fullTraceInclude: string[]
	artifactNativeResiduals: ReadonlyMap<string, ReadonlySet<string>>
	onTracedPackages(packages: TracedPackages): void
}): Plugin {
	const include = new Set(options.include)
	const omittedManagedDatabaseEntries = new Map<string, StaticApplicationManagedDatabaseDriver>(
		options.omittedManagedDatabaseDrivers.map((driver) => [ManagedDatabaseEntries[driver], driver]),
	)
	const tracedPaths = new Set<string>()
	const declaredWorkspacePackages = new Map<string, DeclaredWorkspacePackage>()
	return {
		name: 'pluxel:nf3-externals',
		async buildStart() {
			tracedPaths.clear()
			declaredWorkspacePackages.clear()
			const requireFromApplication = createRequire(resolve(options.cwd, 'package.json'))
			for (const packageName of options.declaredPackages) {
				let resolved: string | undefined
				let requireError: unknown
				try {
					resolved = requireFromApplication.resolve(packageName)
				} catch (error) {
					requireError = error
				}
				if (!resolved || !isAbsolute(resolved)) {
					const imported = await this.resolve(packageName, resolve(options.cwd, 'package.json'), {
						skipSelf: true,
					})
					if (imported?.id && isAbsolute(imported.id)) resolved = imported.id
				}
				if (!resolved || !isAbsolute(resolved)) {
					const detail = requireError instanceof Error ? `: ${requireError.message}` : ''
					this.error(
						`[static-application] residual dependency ${JSON.stringify(packageName)} cannot be resolved from ${options.cwd}${detail}`,
					)
				}
				tracedPaths.add(resolved.split('?', 1)[0])
				const declaredPackage = await findDeclaredPackage(resolved, packageName)
				if (!/(^|[\\/])node_modules([\\/]|$)/.test(declaredPackage.root)) {
					declaredWorkspacePackages.set(packageName, declaredPackage)
				}
			}
		},
		async resolveId(id, importer, resolveOptions) {
			const omittedDriver = omittedManagedDatabaseEntries.get(id)
			if (omittedDriver) return `${OMITTED_MANAGED_DATABASE_PREFIX}${omittedDriver}`
			const packageName = readPackageName(id)
			if (!packageName || !include.has(packageName)) return null
			const resolved = await this.resolve(id, importer, resolveOptions)
			if (!resolved?.id || !isAbsolute(resolved.id)) return resolved
			tracedPaths.add(resolved.id.split('?', 1)[0])
			return {
				...resolved,
				external: true,
				id,
			}
		},
		load(id) {
			if (!id.startsWith(OMITTED_MANAGED_DATABASE_PREFIX)) return null
			const driver = id.slice(
				OMITTED_MANAGED_DATABASE_PREFIX.length,
			) as StaticApplicationManagedDatabaseDriver
			const exportName =
				driver === 'pglite' ? 'createPgliteDatabaseAdapter' : 'createPostgresDatabaseAdapter'
			return [
				`export async function ${exportName}() {`,
				`  throw new Error(${JSON.stringify(`[static-application] managed database driver "${driver}" is not included in this deployment`)})`,
				'}',
			].join('\n')
		},
		writeBundle: {
			order: 'post',
			async handler() {
				for (const [packageName, entries] of options.artifactNativeResiduals) {
					for (const resolved of entries) {
						tracedPaths.add(resolved)
						const declaredPackage = await findDeclaredPackage(resolved, packageName)
						if (!/(^|[\\/])node_modules([\\/]|$)/.test(declaredPackage.root)) {
							declaredWorkspacePackages.set(packageName, declaredPackage)
						}
					}
				}
				if (tracedPaths.size === 0) {
					options.onTracedPackages({})
					return
				}
				const { traceNodeModules } = await import('nf3')
				const traceBase = findFilesystemRoot(options.cwd)
				const workspaceFiles = new Map<string, Set<string>>()
				await traceNodeModules([...tracedPaths], {
					rootDir: options.cwd,
					outDir: options.outDir,
					conditions: options.conditions,
					nft: { base: traceBase },
					writePackageJson: false,
					fullTraceInclude: options.fullTraceInclude,
					hooks: {
						traceResult(result) {
							for (const rawFile of result.fileList) {
								const file = isAbsolute(rawFile) ? rawFile : resolve(traceBase, rawFile)
								for (const declaredPackage of declaredWorkspacePackages.values()) {
									if (!isPathInside(declaredPackage.root, file)) continue
									let files = workspaceFiles.get(declaredPackage.name)
									if (!files) {
										files = new Set()
										workspaceFiles.set(declaredPackage.name, files)
									}
									files.add(file)
								}
							}
						},
						async tracedPackages(packages) {
							for (const declaredPackage of declaredWorkspacePackages.values()) {
								const files = options.declaredFullTracePackages.includes(declaredPackage.name)
									? await listPackageFiles(declaredPackage.root)
									: [...(workspaceFiles.get(declaredPackage.name) ?? [])]
								if (files.length === 0) {
									throw new Error(
										`[static-application] residual dependency ${JSON.stringify(declaredPackage.name)} produced no runtime files`,
									)
								}
								await copyWorkspacePackage(
									declaredPackage,
									files,
									resolve(options.outDir, 'node_modules', declaredPackage.name),
								)
								const existing = packages[declaredPackage.name]
								packages[declaredPackage.name] = {
									name: declaredPackage.name,
									versions: {
										...existing?.versions,
										[declaredPackage.version]: {
											pkgJSON: declaredPackage.packageJson as TracedPackageVersion['pkgJSON'],
											path: declaredPackage.root,
											files,
										},
									},
								}
							}
							options.onTracedPackages(packages)
						},
					},
				})
			},
		},
	}
}

async function findDeclaredPackage(
	entry: string,
	expectedName: string,
): Promise<DeclaredWorkspacePackage> {
	let root = dirname(entry)
	while (true) {
		const packageJsonPath = resolve(root, 'package.json')
		if (existsSync(packageJsonPath)) {
			const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<
				string,
				unknown
			>
			if (packageJson.name === expectedName) {
				return {
					name: expectedName,
					root,
					version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0',
					packageJson,
				}
			}
		}
		const parent = dirname(root)
		if (parent === root) break
		root = parent
	}
	throw new Error(
		`[static-application] residual dependency ${JSON.stringify(expectedName)} resolved outside its package root: ${entry}`,
	)
}

function findFilesystemRoot(path: string): string {
	let root = resolve(path)
	while (dirname(root) !== root) root = dirname(root)
	return root
}

function isPathInside(root: string, file: string): boolean {
	const child = relative(root, file)
	return child !== '' && child !== '..' && !child.startsWith('../') && !isAbsolute(child)
}

async function listPackageFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true })
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => resolve(entry.parentPath, entry.name))
		.filter((file) => !relative(root, file).split('/').includes('node_modules'))
}

async function copyWorkspacePackage(
	declaredPackage: DeclaredWorkspacePackage,
	files: readonly string[],
	destinationRoot: string,
): Promise<void> {
	await Promise.all(
		files.map(async (file) => {
			const subpath = relative(declaredPackage.root, file)
			if (!subpath || subpath === '..' || subpath.startsWith('../') || isAbsolute(subpath)) return
			const destination = resolve(destinationRoot, subpath)
			await mkdir(dirname(destination), { recursive: true })
			await cp(file, destination, { force: true })
		}),
	)
}

function resolveResidualDependencies(
	value: StaticApplicationResidualDependencies | undefined,
): Required<StaticApplicationResidualDependencies> {
	const packages = readResidualPackageList(value?.packages, 'packages')
	const fullTrace = [...new Set(readResidualPackageList(value?.fullTrace, 'fullTrace'))]
	return {
		packages: [...new Set([...packages, ...fullTrace])],
		fullTrace,
	}
}

function resolveManagedDatabaseDrivers(
	value: readonly StaticApplicationManagedDatabaseDriver[] | undefined,
): StaticApplicationManagedDatabaseDriver[] {
	if (value === undefined) return [...ManagedDatabaseDrivers]
	if (!Array.isArray(value)) {
		throw new TypeError('[static-application] managedDatabaseDrivers must be an array')
	}
	const requested = new Set(
		value.map((driver, index) => {
			if (!ManagedDatabaseDrivers.includes(driver)) {
				throw new TypeError(
					`[static-application] managedDatabaseDrivers[${index}] must be "pglite" or "postgres"`,
				)
			}
			return driver
		}),
	)
	return ManagedDatabaseDrivers.filter((driver) => requested.has(driver))
}

function readResidualPackageList(value: readonly string[] | undefined, field: string): string[] {
	if (value === undefined) return []
	if (!Array.isArray(value)) {
		throw new TypeError(`[static-application] residualDependencies.${field} must be an array`)
	}
	return value.map((packageName, index) => {
		if (
			typeof packageName !== 'string' ||
			packageName.length === 0 ||
			/\s/.test(packageName) ||
			readPackageName(packageName) !== packageName ||
			(packageName.startsWith('@') && packageName.split('/').length !== 2)
		) {
			throw new TypeError(
				`[static-application] residualDependencies.${field}[${index}] must be a package name without a subpath`,
			)
		}
		return packageName
	})
}

function readPackageName(id: string): string | null {
	if (!id || id.startsWith('.') || id.startsWith('/') || id.includes(':')) return null
	const [first, second] = id.split('/')
	if (!first) return null
	return first.startsWith('@') && second ? `${first}/${second}` : first
}

function staticApplicationEntryPlugin(options: {
	entry: string
	variant: 'headless' | 'workbench'
	launcher: 'node' | 'fetch'
	state: StaticApplicationBuildState
}): Plugin {
	return {
		name: 'pluxel-static-application-entry',
		resolveId(id) {
			if (id === STATIC_APPLICATION_BOOTSTRAP_ID) {
				return RESOLVED_STATIC_APPLICATION_BOOTSTRAP_ID
			}
			return null
		},
		load(id) {
			if (id !== RESOLVED_STATIC_APPLICATION_BOOTSTRAP_ID) return null
			return buildBootstrap(options.entry, options.variant, options.launcher)
		},
	}
}

function buildBootstrap(
	entry: string,
	variant: 'headless' | 'workbench',
	launcher: 'node' | 'fetch',
): string {
	const deployment = `{ root: import.meta.dirname, target: 'node', variant: ${JSON.stringify(variant)} }`
	const workbench = variant === 'workbench'
	const [runnerModule, runner] =
		launcher === 'fetch'
			? workbench
				? [
						'@pluxel/runtime-static/internal/fetch-workbench-application',
						'runStaticFetchWorkbenchApplication',
					]
				: ['@pluxel/runtime-static/internal/fetch-application', 'runStaticFetchApplication']
			: workbench
				? [
						'@pluxel/runtime-static/internal/node-workbench-application',
						'runStaticNodeWorkbenchApplication',
					]
				: ['@pluxel/runtime-static/internal/node-application', 'runStaticNodeApplication']
	return `
import 'pluxel:static-elysia-wiring'
import { readHostProduct as __readHostProduct } from '@pluxel/runtime/internal/static-host'
import * as __pluxelHostModule from ${JSON.stringify(entry)}
import { ${runner} as __runStaticApplication } from ${JSON.stringify(runnerModule)}
const __pluxelProduct = __readHostProduct(__pluxelHostModule, ${JSON.stringify(`[static-application] ${entry}`)})
const __pluxelStaticRuntime = await __runStaticApplication(__pluxelHostModule.default, {
	env: process.env,
	deployment: ${deployment},
	product: __pluxelProduct,
})
export const ctx = __pluxelStaticRuntime.ctx
export const fetch = __pluxelStaticRuntime.fetch
export const start = __pluxelStaticRuntime.start
export const stop = __pluxelStaticRuntime.stop
${launcher === 'node' ? 'export const address = __pluxelStaticRuntime.address' : ''}
`
}

function staticApplicationAssemblyPlugin(options: {
	cwd: string
	outDir: string
	variant: 'headless' | 'workbench'
	state: StaticApplicationBuildState
}): Plugin {
	return {
		name: 'pluxel-static-application-assembly',
		writeBundle: {
			order: 'post',
			async handler(_, bundle) {
				assertBundledPluxelClosure(bundle)
				await mkdir(options.outDir, { recursive: true })
				options.state.environmentExampleOwned = await writeStaticConfigEnvironmentExample({
					outDir: options.outDir,
					bundle,
					content: options.state.environmentExample,
					ownedExisting: options.state.environmentExampleOwned,
				})
				if (options.variant === 'workbench') {
					const runtime = resolveRuntimeWorkbenchDistribution(options.cwd)
					await assertWorkbenchShellContractProtocol(runtime.publicDir, runtime.contractProtocol)
					await cp(runtime.publicDir, resolve(options.outDir, 'workbench/public'), {
						recursive: true,
						force: true,
					})
					await copyBundledPackageWorkbenchArtifacts(bundle, resolve(options.outDir, 'workbench'))
				}
				const entry = Object.values(bundle).find(
					(item): item is OutputChunk => item.type === 'chunk' && item.isEntry,
				)
				if (!entry) throw new Error('[static-application] server entry chunk was not generated')
				const artifacts =
					options.variant === 'workbench'
						? await collectWorkbenchArtifacts(resolve(options.outDir, 'workbench'))
						: []
				const nodeModules = await collectNodeModuleArtifacts(
					resolve(options.outDir, 'artifacts/node'),
				)
				const catalogHash = createHash('sha256')
					.update(
						Object.values(bundle)
							.filter((item): item is OutputChunk => item.type === 'chunk')
							.sort((a, b) => a.fileName.localeCompare(b.fileName))
							.map((item) => `${item.fileName}\0${item.code}`)
							.join('\0'),
					)
					.digest('hex')
				await writeFile(
					resolve(options.outDir, 'pluxel-deployment.json'),
					`${JSON.stringify(
						{
							version: 1,
							kind: 'pluxel-static-application',
							application: {
								name: options.state.name ?? null,
								catalogHash,
							},
							server: {
								entry: entry.fileName,
								runtimeClosure: 'bundled',
								target: 'node',
							},
							capabilities: {
								nodeModules: {
									root: 'artifacts/node',
									artifacts: nodeModules,
								},
								workbench: {
									included: options.variant === 'workbench',
									publicRoot: options.variant === 'workbench' ? 'workbench/public' : null,
									artifacts,
								},
							},
							residualDependencies: {
								mode: options.state.residualPackages.length > 0 ? 'trace' : 'bundle',
								packages: options.state.residualPackages,
							},
						},
						null,
						2,
					)}\n`,
					'utf-8',
				)
				await createDistributionManifest(options.outDir)
			},
		},
	}
}

async function copyBundledPackageWorkbenchArtifacts(
	bundle: OutputBundle,
	destinationRoot: string,
): Promise<void> {
	await runWorkbenchOutputTransaction(destinationRoot, async () => {
		const packageRoots = new Set<string>()
		for (const item of Object.values(bundle)) {
			if (item.type !== 'chunk') continue
			for (const rawId of Object.keys(item.modules)) {
				const id = rawId.split('?', 1)[0]
				if (!isAbsolute(id)) continue
				const packageRoot = await findNearestPackageRoot(id)
				if (packageRoot) packageRoots.add(packageRoot)
			}
		}

		for (const packageRoot of packageRoots) {
			const sourceRoot = resolve(packageRoot, 'dist/workbench')
			if (sourceRoot === destinationRoot) continue
			const entries = await readdir(sourceRoot, { withFileTypes: true }).catch((): never[] => [])
			for (const entry of entries) {
				if (!entry.isDirectory()) continue
				const source = resolve(sourceRoot, entry.name)
				const sourceManifest = resolve(source, 'mf-manifest.json')
				if (!existsSync(sourceManifest)) continue
				const destination = resolve(destinationRoot, entry.name)
				const destinationManifest = resolve(destination, 'mf-manifest.json')
				if (existsSync(destinationManifest)) {
					const [sourceContent, destinationContent] = await Promise.all([
						readFile(sourceManifest),
						readFile(destinationManifest),
					])
					if (!sourceContent.equals(destinationContent)) {
						throw new Error(`[static-application] Workbench artifact collision: ${entry.name}`)
					}
					continue
				}
				await cp(source, destination, { recursive: true, force: true })
			}
		}
	})
}

async function findNearestPackageRoot(file: string): Promise<string | null> {
	let current = dirname(file)
	while (true) {
		if (existsSync(resolve(current, 'package.json'))) return current
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
}

function assertBundledPluxelClosure(bundle: OutputBundle): void {
	for (const item of Object.values(bundle)) {
		if (item.type !== 'chunk') continue
		for (const specifier of [...item.imports, ...item.dynamicImports]) {
			if (specifier.startsWith('@pluxel/')) {
				throw new Error(
					`[static-application] ${item.fileName} still imports deployment dependency ${specifier}`,
				)
			}
		}
	}
}

function resolveRuntimeWorkbenchDistribution(cwd: string): {
	publicDir: string
	contractProtocol: number
} {
	const applicationRequire = createRequire(resolve(cwd, 'package.json'))
	const routeRoot = dirname(applicationRequire.resolve('@pluxel/runtime-static/package.json'))
	const routeRequire = createRequire(resolve(routeRoot, 'package.json'))
	const packageJsonPath = routeRequire.resolve('@pluxel/runtime/package.json')
	const packageRoot = dirname(packageJsonPath)
	const metadata = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
		pluxel?: { workbenchContractProtocol?: unknown }
	}
	const contractProtocol = metadata.pluxel?.workbenchContractProtocol
	if (!Number.isInteger(contractProtocol) || Number(contractProtocol) <= 0) {
		throw new Error(
			'[static-application] @pluxel/runtime does not declare pluxel.workbenchContractProtocol',
		)
	}
	for (const candidate of [resolve(packageRoot, 'dist/public'), resolve(packageRoot, 'public')]) {
		if (existsSync(candidate)) {
			return { publicDir: candidate, contractProtocol: Number(contractProtocol) }
		}
	}
	throw new Error(
		'[static-application] Workbench variant requires the built @pluxel/runtime public shell',
	)
}

export async function assertWorkbenchShellContractProtocol(
	publicDir: string,
	expectedProtocol: number,
): Promise<void> {
	const buildInfoPath = resolve(publicDir, WORKBENCH_SHELL_BUILD_INFO_FILE)
	let buildInfo: { version?: unknown; contractProtocol?: unknown }
	try {
		buildInfo = JSON.parse(await readFile(buildInfoPath, 'utf-8')) as typeof buildInfo
	} catch {
		throw new Error(
			`[static-application] Workbench shell build info is missing or invalid: ${buildInfoPath}; rebuild @pluxel/runtime`,
		)
	}
	if (
		buildInfo.version !== WORKBENCH_SHELL_BUILD_INFO_VERSION ||
		buildInfo.contractProtocol !== expectedProtocol
	) {
		throw new Error(
			`[static-application] Workbench shell contract protocol mismatch: expected ${expectedProtocol}, built ${String(buildInfo.contractProtocol ?? '<missing>')}; rebuild @pluxel/runtime`,
		)
	}
}

async function collectWorkbenchArtifacts(root: string): Promise<unknown[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch((): never[] => [])
	const artifacts: unknown[] = []
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const manifest = resolve(root, entry.name, 'mf-manifest.json')
		if (!existsSync(manifest)) continue
		const content = await readFile(manifest, 'utf-8')
		artifacts.push({
			name: entry.name,
			manifest: relative(dirname(root), manifest),
			sha256: createHash('sha256').update(content).digest('hex'),
		})
	}
	return artifacts.sort((a, b) =>
		String((a as { name: string }).name).localeCompare(String((b as { name: string }).name)),
	)
}

async function collectNodeModuleArtifacts(root: string): Promise<unknown[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch((): never[] => [])
	const artifacts: Array<{ key: string; file: string; sha256: string }> = []
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
		const file = resolve(root, entry.name)
		const content = await readFile(file)
		artifacts.push({
			key: entry.name.slice(0, -4),
			file: relative(dirname(dirname(root)), file),
			sha256: createHash('sha256').update(content).digest('hex'),
		})
	}
	return artifacts.sort((a, b) => a.key.localeCompare(b.key))
}
