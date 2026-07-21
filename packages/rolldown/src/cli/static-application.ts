import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { FullTracePackages, NodeNativePackages, NonBundleablePackages } from 'nf3/db'
import { dirname, isAbsolute, relative, resolve } from 'pathe'
import type { OutputBundle, OutputChunk, Plugin } from 'rolldown'
import type { UserConfig } from 'tsdown'
import { parseWithLang } from '../rolldown/plugins/pluginUtils'
import { createPluginBuildPipeline } from './plugin-build'

export type StaticApplicationBuildOptions = {
	entry: string
	cwd?: string
	outDir?: string
	variant?: 'headless' | 'workbench'
	target?: 'node'
	residualDependencies?: StaticApplicationResidualDependencies
	minify?: boolean
	sourcemap?: boolean
	lint?: boolean
}

export type StaticApplicationResidualDependencies = {
	packages?: readonly string[]
	fullTrace?: readonly string[]
}

type StaticApplicationBuildState = {
	name?: string
	residualPackages: string[]
}

type DeclaredWorkspacePackage = {
	name: string
	root: string
	version: string
	packageJson: Record<string, unknown>
}

const RuntimeResidualPackages = ['@electric-sql/pglite', 'pg'] as const
const RuntimeFullTracePackages = ['tslib', '@electric-sql/pglite'] as const

export function staticApplication(options: StaticApplicationBuildOptions): UserConfig {
	const cwd = resolve(options.cwd ?? process.cwd())
	const entry = resolve(cwd, options.entry)
	const outDir = resolve(cwd, options.outDir ?? 'dist')
	const variant = options.variant ?? 'workbench'
	const target = String(options.target ?? 'node')
	if (target !== 'node')
		throw new Error('[static-application] only the node target is currently supported')
	const residualDependencies = resolveResidualDependencies(options.residualDependencies)
	const state: StaticApplicationBuildState = { residualPackages: [] }
	const buildDir = relative(cwd, outDir) || '.'
	const sourcePipeline = createPluginBuildPipeline({
		root: cwd,
		lint: options.lint,
		artifactBuildDir: buildDir,
		workbench: variant === 'workbench' ? { buildDir, minify: options.minify ?? true } : false,
	})

	return {
		name: 'pluxel-static-application',
		cwd,
		entry: { app: entry },
		outDir,
		platform: 'node',
		target: 'node24',
		format: 'esm',
		fixedExtension: true,
		dts: false,
		clean: true,
		minify: options.minify ?? true,
		sourcemap: options.sourcemap ?? false,
		treeshake: true,
		hash: true,
		deps: {
			alwaysBundle: () => true,
			onlyBundle: false,
		},
		plugins: [
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
				conditions: ['node', 'import', 'default'],
				fullTraceInclude: [
					...FullTracePackages,
					...RuntimeFullTracePackages,
					...residualDependencies.fullTrace,
				],
				onTracedPackages(packages) {
					state.residualPackages = Object.keys(packages).sort()
				},
			}),
			staticApplicationEntryPlugin({ entry, variant, state }),
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
	conditions: string[]
	fullTraceInclude: string[]
	onTracedPackages(packages: Record<string, unknown>): void
}): Plugin {
	const include = new Set(options.include)
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
		writeBundle: {
			order: 'post',
			async handler() {
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
								const existing = packages[declaredPackage.name] as
									| { name?: string; versions?: Record<string, unknown> }
									| undefined
								packages[declaredPackage.name] = {
									name: declaredPackage.name,
									versions: {
										...existing?.versions,
										[declaredPackage.version]: {
											pkgJSON: declaredPackage.packageJson,
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
	state: StaticApplicationBuildState
}): Plugin {
	return {
		name: 'pluxel-static-application-entry',
		transform(code, rawId) {
			const id = rawId.split('?', 1)[0]
			if (resolve(id) !== options.entry) return null
			const ast = parseWithLang(this, code, id)
			if (!ast) this.error(`[static-application] failed to parse entry: ${id}`)
			const defaults = ast.body.filter((node) => node.type === 'ExportDefaultDeclaration')
			if (defaults.length !== 1) {
				this.error('[static-application] entry must contain exactly one default export')
			}
			const declaration = defaults[0] as unknown as {
				start: number
				end: number
				declaration?: {
					type?: string
					start?: number
					end?: number
					callee?: { type?: string; name?: string }
					arguments?: unknown[]
				}
			}
			const expression = declaration.declaration
			if (
				expression?.type !== 'CallExpression' ||
				expression.callee?.type !== 'Identifier' ||
				expression.callee.name !== 'defineStaticRuntime'
			) {
				this.error(
					'[static-application] entry must default-export defineStaticRuntime(...) directly',
				)
			}
			if (typeof expression.start !== 'number' || typeof expression.end !== 'number') {
				this.error('[static-application] cannot locate defineStaticRuntime(...) source range')
			}
			options.state.name = readApplicationName(expression.arguments?.[0])
			const applicationExpression = code.slice(expression.start, expression.end)
			const replacement = `const __pluxelStaticApplication = ${applicationExpression}\nexport default __pluxelStaticApplication`
			const bootstrap = buildBootstrap(options.variant)
			return {
				code: `${code.slice(0, declaration.start)}${replacement}${code.slice(declaration.end)}\n${bootstrap}\n`,
				map: null,
			}
		},
	}
}

function buildBootstrap(variant: 'headless' | 'workbench'): string {
	const deployment = `{ root: import.meta.dirname, target: 'node', variant: ${JSON.stringify(variant)} }`
	const [runnerModule, runner] =
		variant === 'workbench'
			? [
					'@pluxel/runtime-static/internal/node-workbench-application',
					'runStaticNodeWorkbenchApplication',
				]
			: ['@pluxel/runtime-static/internal/node-application', 'runStaticNodeApplication']
	return `
import { ${runner} as __runStaticNodeApplication } from ${JSON.stringify(runnerModule)}
const __pluxelStaticRuntime = await __runStaticNodeApplication(__pluxelStaticApplication, {
	env: process.env,
	deployment: ${deployment},
})
export const ctx = __pluxelStaticRuntime.ctx
export const fetch = __pluxelStaticRuntime.fetch
export const start = __pluxelStaticRuntime.start
export const stop = __pluxelStaticRuntime.stop
export const address = __pluxelStaticRuntime.address
`
}

function readApplicationName(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined
	const object = value as {
		type?: string
		properties?: Array<{
			type?: string
			key?: { type?: string; name?: string; value?: unknown }
			value?: { type?: string; value?: unknown }
		}>
	}
	if (object.type !== 'ObjectExpression') return undefined
	for (const property of object.properties ?? []) {
		if (property.type !== 'Property') continue
		const key =
			property.key?.type === 'Identifier'
				? property.key.name
				: property.key?.type === 'Literal'
					? property.key.value
					: undefined
		if (key !== 'name') continue
		return property.value?.type === 'Literal' && typeof property.value.value === 'string'
			? property.value.value
			: undefined
	}
	return undefined
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
				if (options.variant === 'workbench') {
					const runtimePublic = resolveRuntimePublicDir(options.cwd)
					await cp(runtimePublic, resolve(options.outDir, 'workbench/public'), {
						recursive: true,
						force: true,
					})
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
			},
		},
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

function resolveRuntimePublicDir(cwd: string): string {
	const applicationRequire = createRequire(resolve(cwd, 'package.json'))
	const routeRoot = dirname(applicationRequire.resolve('@pluxel/runtime-static/package.json'))
	const routeRequire = createRequire(resolve(routeRoot, 'package.json'))
	const packageRoot = dirname(routeRequire.resolve('@pluxel/runtime/package.json'))
	for (const candidate of [resolve(packageRoot, 'dist/public'), resolve(packageRoot, 'public')]) {
		if (existsSync(candidate)) return candidate
	}
	throw new Error(
		'[static-application] Workbench variant requires the built @pluxel/runtime public shell',
	)
}

async function collectWorkbenchArtifacts(root: string): Promise<unknown[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
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
	const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
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
