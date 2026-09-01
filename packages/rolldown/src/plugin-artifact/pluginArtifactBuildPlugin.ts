import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import {
	createWorkbenchFederationDeploymentInventory,
	workbenchFederationBuildOutDir,
	workbenchFederationDeploymentInventoryPath,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import type { Program } from 'oxc-parser'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'pathe'
import {
	findDatabasePackageRoot,
	loadDatabaseArtifactForSource,
	type DatabaseBuildArtifact,
} from '../database/artifact.ts'
import { extractDatabaseDeclarations } from '../database/declaration.ts'
import { generateResetDatabaseArtifact } from '../database/reset-artifact.ts'
import { resolveWithOxc } from '../resolver/oxc.ts'
import { collectImportSpecifiers } from '../rolldown/plugins/importCollector.ts'
import type {
	WorkbenchSemanticPageCompilation,
	WorkbenchSemanticProducerCompilation,
} from '../workbench/semantic-lowering.ts'
import { allowOptionalQuerySuffix, type ViteCompatPlugin } from '../rolldown/plugins/compat.ts'
import {
	normalizePatterns,
	parseStandaloneWithLang,
	parseWithLang,
} from '../rolldown/plugins/pluginUtils.ts'
import { normalizeViteId } from '../rolldown/plugins/viteNormalizeId.ts'
import { resolveNodeModuleArtifactKey, resolveNodeModuleBuildSignature } from './declaration.ts'

const NODE_MODULE_BUILD_CACHE_VERSION = 1
const PRODUCTION_ARTIFACT_CACHE_KEEP = 3
const CODE_HINT = /\b(?:defineNodeModule\s*\(|defineWorkerTask\b)/
const DATABASE_CODE_HINT = /\bdefineDatabase\s*\(/
const NODE_MODULE_IMPORT_SOURCE = '@pluxel/runtime'
const NODE_ARTIFACT_RESOLVE_CONDITIONS = [
	'@pluxel/hmr',
	'development',
	'@pluxel/source',
	'node',
	'import',
	'module',
	'default',
]
const productionBuilds = new Map<string, Promise<void>>()

type NodeLike = {
	type?: unknown
	start?: unknown
	end?: unknown
	[key: string]: unknown
}

type NodeModuleDeclaration = Readonly<{
	artifactKey: string
	entryPath: string
	insertOffset: number
}>

type DatabasePackageArtifact = Readonly<{
	sourceFile: string
	migrationsDir: string
	artifact: DatabaseBuildArtifact
	cleanup?: () => Promise<void>
}>

export type PluginArtifactBuildPluginOptions = {
	/** Package/application root used for declaration identity and relative entries. @defaultValue process.cwd() */
	root?: string
	/** Output directory relative to `root`. @defaultValue 'dist' */
	buildDir?: string
	/** Workbench producer policy. Plans must come from the Plugin semantic/descriptor lowering pass. */
	workbench?:
		| false
		| {
				/** Minifies Workbench remote output when true. @defaultValue true */
				minify?: boolean
				/** @internal Returns each final plan with the package root that owns its browser graph. */
				compilations?: () =>
					| readonly WorkbenchSemanticProducerCompilation[]
					| Promise<readonly WorkbenchSemanticProducerCompilation[]>
				/** @internal Returns canonical immutable Standard Page sets. */
				pageCompilations?: () =>
					| readonly WorkbenchSemanticPageCompilation[]
					| Promise<readonly WorkbenchSemanticPageCompilation[]>
		  }
	/** Node artifact build policy. Omission enables Node artifacts with default minification. */
	node?: {
		/** Minifies the single-file Node artifact. @defaultValue true */
		minify?: boolean
		/** @internal Reports controlled native imports to the static deployment tracer. */
		onNativeResidual?: (name: string, resolvedEntry: string) => void
		/** @internal Clears native residual facts at the next build generation. */
		onNativeResidualReset?: () => void
	}
	/** Source files eligible for declaration extraction. Omission uses the built-in JS/TS patterns. */
	include?: string | string[]
	/** Source files excluded from declaration extraction. Omission excludes dependencies, dist, and declarations. */
	exclude?: string | string[]
	/** Optional build/reuse diagnostic sink. Omission emits no plugin artifact messages. */
	log?: (message: string) => void
}

export function pluginArtifactBuildPlugin(
	options: PluginArtifactBuildPluginOptions = {},
): ViteCompatPlugin {
	const root = resolve(options.root ?? process.cwd())
	const nodeDeclarations = new Map<string, NodeModuleDeclaration>()
	const databasePackages = new Map<string, DatabasePackageArtifact>()
	const includePatterns = normalizePatterns(options.include, [
		'**/*.ts',
		'**/*.tsx',
		'**/*.mts',
		'**/*.cts',
		'**/*.js',
		'**/*.jsx',
		'**/*.mjs',
		'**/*.cjs',
	]).map(allowOptionalQuerySuffix)
	const excludePatterns = normalizePatterns(options.exclude, [
		'**/node_modules/**',
		'**/dist/**',
		'**/*.d.ts',
		'**/*.d.mts',
		'**/*.d.cts',
	]).map(allowOptionalQuerySuffix)

	return {
		name: 'pluxel-plugin-artifact-build',
		enforce: 'pre',
		async buildStart() {
			options.node?.onNativeResidualReset?.()
			await cleanupGeneratedDatabaseArtifacts(databasePackages)
			nodeDeclarations.clear()
			databasePackages.clear()
		},
		transform: {
			filter: {
				id: { include: includePatterns, exclude: excludePatterns },
			},
			async handler(code, rawId) {
				if (!CODE_HINT.test(code) && !DATABASE_CODE_HINT.test(code)) return null
				const id = normalizeViteId(rawId)
				const ast = parseWithLang(this, code, id)
				if (!ast) this.error(`[pluxel] failed to parse declaration module: ${id}`)
				const extractedNode = extractNodeModuleDeclarations(ast, code, id, root)
				const databaseDeclarations = extractDatabaseDeclarations(ast, code, id)
				let databaseArtifact: string | undefined
				if (databaseDeclarations.length > 0) {
					const declaration = databaseDeclarations[0]!
					const packageRoot = findDatabasePackageRoot(id, root)
					if (!packageRoot) this.error(`[database] cannot locate package.json for ${id}`)
					let loaded = databasePackages.get(packageRoot)
					if (loaded && loaded.sourceFile !== id) {
						this.error(
							`[database] package ${packageRoot} declares databases in both ${loaded.sourceFile} and ${id}`,
						)
					}
					if (!loaded) {
						if (declaration.evolution === 'reset-on-schema-change') {
							const generated = await generateResetDatabaseArtifact({
								root: packageRoot,
								schema: id,
							})
							loaded = {
								sourceFile: id,
								migrationsDir: generated.migrationsDir,
								artifact: generated.artifact,
								cleanup: generated.cleanup,
							}
						} else {
							const checked = await loadDatabaseArtifactForSource(id, root)
							loaded = { sourceFile: id, ...checked }
						}
						databasePackages.set(packageRoot, loaded)
					}
					if (loaded.artifact.evolution !== declaration.evolution) {
						this.error(
							`[database] ${id} declares evolution "${declaration.evolution}" but its artifact uses "${loaded.artifact.evolution}"`,
						)
					}
					databaseArtifact = JSON.stringify(loaded.artifact)
				}
				for (const declaration of extractedNode) {
					const existing = nodeDeclarations.get(declaration.artifactKey)
					if (existing && existing.entryPath !== declaration.entryPath) {
						this.error(`[node-module] artifact key collision: ${declaration.artifactKey}`)
					}
					nodeDeclarations.set(declaration.artifactKey, declaration)
				}
				if (extractedNode.length === 0 && databaseDeclarations.length === 0) return null
				let transformed = code
				const lowerings = [
					...extractedNode.map((item) => ({
						value: injectedArgument(code, item.insertOffset, JSON.stringify(item.artifactKey)),
						offset: item.insertOffset,
					})),
					...databaseDeclarations.map((item) => ({
						value: injectedArgument(code, item.insertOffset, databaseArtifact!),
						offset: item.insertOffset,
					})),
				].sort((a, b) => b.offset - a.offset)
				for (const declaration of lowerings) {
					transformed = `${transformed.slice(0, declaration.offset)}${declaration.value}${transformed.slice(declaration.offset)}`
				}
				return { code: transformed, map: null }
			},
		},
		async writeBundle() {
			const producerCompilations =
				options.workbench === false ? [] : await (options.workbench?.compilations?.() ?? [])
			const pageCompilations =
				options.workbench === false ? [] : await (options.workbench?.pageCompilations?.() ?? [])
			for (const compilation of pageCompilations) {
				for (const source of compilation.sources) this.addWatchFile(source)
			}
			const producerPlans = producerCompilations.map((compilation) => compilation.plan)
			const pageTools =
				options.workbench === false ? undefined : await import('../workbench/page-artifact.ts')
			const pageEntries = pageTools
				? await Promise.all(
						pageCompilations.map((compilation) =>
							pageTools.publishWorkbenchPageArtifact(root, options.buildDir ?? 'dist', compilation),
						),
					)
				: []
			await Promise.all([
				...producerCompilations
					.toSorted((left, right) => left.plan.producer.localeCompare(right.plan.producer))
					.map((compilation) => buildProductionProducer(root, compilation, options)),
				...[...nodeDeclarations.values()]
					.sort((a, b) => a.artifactKey.localeCompare(b.artifactKey))
					.map((declaration) => buildProductionNodeModule(root, declaration, options)),
				...(databasePackages.get(root)
					? [copyDatabaseMigrations(databasePackages.get(root)!.migrationsDir, root, options)]
					: []),
			])
			if (options.workbench !== false) {
				await Promise.all([
					writeWorkbenchDeploymentInventory(root, producerPlans, options),
					pageTools!.writeWorkbenchPageDeploymentInventory(
						root,
						options.buildDir ?? 'dist',
						pageEntries,
					),
				])
			}
		},
		async closeBundle() {
			await cleanupGeneratedDatabaseArtifacts(databasePackages)
			databasePackages.clear()
		},
	}
}

async function writeWorkbenchDeploymentInventory(
	root: string,
	plans: readonly WorkbenchFederationProducerPlan[],
	options: PluginArtifactBuildPluginOptions,
): Promise<void> {
	const inventory = createWorkbenchFederationDeploymentInventory(plans)
	const target = resolve(
		root,
		workbenchFederationDeploymentInventoryPath(options.buildDir ?? 'dist'),
	)
	const candidate = `${target}.candidate-${randomUUID()}`
	await mkdir(dirname(target), { recursive: true })
	try {
		await writeFile(candidate, `${JSON.stringify(inventory)}\n`, 'utf-8')
		await rename(candidate, target)
	} catch (error) {
		await rm(candidate, { force: true })
		throw error
	}
}

function injectedArgument(code: string, insertOffset: number, value: string): string {
	let index = insertOffset - 1
	while (index >= 0 && /\s/u.test(code[index]!)) index--
	return code[index] === ',' ? ` ${value}` : `, ${value}`
}

async function buildProductionProducer(
	deploymentRoot: string,
	compilation: WorkbenchSemanticProducerCompilation,
	options: PluginArtifactBuildPluginOptions,
): Promise<void> {
	const { plan, root: sourceRoot } = compilation
	const target = options.workbench === false ? {} : (options.workbench ?? {})
	const outDir = resolve(
		deploymentRoot,
		workbenchFederationBuildOutDir(plan, options.buildDir ?? 'dist'),
	)
	options.log?.(`[workbench-ui] build ${plan.producer} (${plan.buildRevision})`)
	const buildTools = await loadWorkbenchUiBuildTools()
	await buildTools.buildWorkbenchFederationProducer({
		root: sourceRoot,
		applicationRoot: deploymentRoot,
		packageMode: 'distribution',
		plan,
		outDir,
		minify: target.minify ?? true,
		sourcemap: false,
	})
}

async function loadWorkbenchUiBuildTools(): Promise<typeof import('../vite/workbench-ui.ts')> {
	try {
		return await import('../vite/workbench-ui.ts')
	} catch (error) {
		throw new Error(
			'[workbench-ui] building a declared UI requires Vite. Install it in the plugin package with `pnpm add -D vite`.',
			{ cause: error },
		)
	}
}

async function buildProductionNodeModule(
	root: string,
	declaration: NodeModuleDeclaration,
	options: PluginArtifactBuildPluginOptions,
): Promise<void> {
	if (!existsSync(declaration.entryPath)) {
		throw new Error(`[node-module] entry file not found: ${declaration.entryPath}`)
	}
	const target = options.node ?? {}
	const sourceHash = await hashNodeModuleGraph(
		root,
		declaration,
		resolveNodeModuleBuildSignature({
			minify: target.minify,
		}),
	)
	const cacheRoot = resolve(root, '.pluxel/plugin-artifacts', 'node', declaration.artifactKey)
	const cachedFile = join(cacheRoot, `${sourceHash}.mjs`)
	const outFile = resolve(
		root,
		options.buildDir ?? 'dist',
		'artifacts/node',
		`${declaration.artifactKey}.mjs`,
	)
	const key = `${cachedFile}\u0000${sourceHash}`
	const existing = productionBuilds.get(key)
	if (existing) return existing

	const task = (async () => {
		const buildTools = await import('./node-module.ts')
		const nativeResiduals = await buildTools.resolveNodeModuleNativeResiduals(
			declaration.entryPath,
			root,
		)
		for (const residual of nativeResiduals) {
			options.node?.onNativeResidual?.(residual.name, residual.entryPath)
		}
		let reusable = existsSync(cachedFile)
		if (reusable) {
			try {
				await buildTools.validateNodeModuleArtifact(cachedFile, {
					root,
					entryPath: declaration.entryPath,
				})
			} catch {
				reusable = false
				await rm(cachedFile, { force: true })
			}
		}
		if (!reusable) {
			options.log?.(`[node-module] build ${declaration.artifactKey} (${sourceHash})`)
			await buildTools.buildNodeModule({
				root,
				entryPath: declaration.entryPath,
				outFile: cachedFile,
				minify: target.minify ?? true,
			})
		} else {
			options.log?.(`[node-module] reuse ${declaration.artifactKey} (${sourceHash})`)
		}
		await publishCachedFile(cachedFile, outFile)
		await cleanupNodeModuleCache(cacheRoot, PRODUCTION_ARTIFACT_CACHE_KEEP, sourceHash)
	})()
	productionBuilds.set(key, task)
	try {
		await task
	} finally {
		if (productionBuilds.get(key) === task) productionBuilds.delete(key)
	}
}

async function publishCachedFile(source: string, target: string): Promise<void> {
	const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	const staged = `${target}.tmp-${nonce}`
	const previous = `${target}.previous-${nonce}`
	await mkdir(dirname(target), { recursive: true })
	await cp(source, staged, { force: true })
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
	if (movedPrevious) await rm(previous, { force: true })
}

async function cleanupNodeModuleCache(
	cacheRoot: string,
	keep: number,
	currentHash: string,
): Promise<void> {
	const entries = await readdir(cacheRoot).catch((): string[] => [])
	const builds: Array<{ name: string; mtime: number }> = []
	for (const name of entries) {
		if (name === `${currentHash}.mjs` || !/^[a-f\d]{16}\.mjs$/.test(name)) continue
		const fileStat = await stat(join(cacheRoot, name)).catch((): null => null)
		if (fileStat?.isFile()) builds.push({ name, mtime: fileStat.mtimeMs })
	}
	builds.sort((a, b) => b.mtime - a.mtime)
	for (const stale of builds.slice(Math.max(0, keep - 1))) {
		await rm(join(cacheRoot, stale.name), { force: true })
	}
}

async function hashNodeModuleGraph(
	root: string,
	declaration: NodeModuleDeclaration,
	buildSignature: string,
): Promise<string> {
	const hash = createHash('sha256')
	hash.update(`node-module-build:${NODE_MODULE_BUILD_CACHE_VERSION}`)
	hash.update(`artifact:${declaration.artifactKey}`)
	hash.update(`build:${buildSignature}`)
	await hashDependencyState(hash, root)
	const queue = [declaration.entryPath]
	const visited = new Set<string>()
	while (queue.length > 0) {
		const file = resolve(queue.shift()!)
		if (visited.has(file)) continue
		visited.add(file)
		const content = await readFile(file, 'utf8')
		hash.update(relative(root, file))
		hash.update(content)
		for (const specifier of collectSourceImports(file, content)) {
			const hit = resolveImport(file, specifier, NODE_ARTIFACT_RESOLVE_CONDITIONS)
			if (hit?.path && existsSync(hit.path)) queue.push(hit.path)
		}
	}
	return hash.digest('hex').slice(0, 16)
}

function extractNodeModuleDeclarations(
	ast: Program,
	code: string,
	id: string,
	root: string,
): NodeModuleDeclaration[] {
	const localNames = collectNodeModuleImports(ast)
	if (localNames.size === 0) return []
	const out: NodeModuleDeclaration[] = []
	const moduleConstCalls = collectModuleConstCallInitializers(ast)
	visitNode(ast as unknown as NodeLike, (node) => {
		if (node.type !== 'CallExpression') return
		const callee = sourceSlice(code, object(node.callee) ?? undefined)
		if (!localNames.has(callee)) return
		if (!moduleConstCalls.has(node)) {
			throw new Error(
				`[node-module] defineNodeModule()/defineWorkerTask() must be the direct initializer of a module-level const in ${id}`,
			)
		}
		const args = array(node.arguments)
		if (args.length !== 2 || sourceSlice(code, args[0]) !== 'import.meta.url') {
			throw new Error(
				`[node-module] declaration must call defineNodeModule()/defineWorkerTask(import.meta.url, "./entry") in ${id}`,
			)
		}
		const relativeEntry = literalString(args[1])
		if (!relativeEntry) {
			throw new Error(`[node-module] entry must be a string literal in ${id}`)
		}
		const insertOffset = Number(node.end) - 1
		if (!Number.isInteger(insertOffset) || insertOffset < 0) {
			throw new Error(`[node-module] cannot locate declaration call in ${id}`)
		}
		const artifactKey = resolveNodeModuleArtifactKey(root, id, relativeEntry)
		out.push({
			artifactKey,
			entryPath: isAbsolute(relativeEntry)
				? resolve(relativeEntry)
				: resolve(dirname(id), relativeEntry),
			insertOffset,
		})
	})
	return out
}

async function copyDatabaseMigrations(
	source: string,
	root: string,
	options: PluginArtifactBuildPluginOptions,
): Promise<void> {
	const target = resolve(root, options.buildDir ?? 'dist', 'database/migrations')
	await rm(target, { recursive: true, force: true })
	await mkdir(dirname(target), { recursive: true })
	await cp(source, target, { recursive: true })
}

async function cleanupGeneratedDatabaseArtifacts(
	packages: ReadonlyMap<string, DatabasePackageArtifact>,
): Promise<void> {
	await Promise.all(
		[...packages.values()].map((artifact) => artifact.cleanup?.() ?? Promise.resolve()),
	)
}

function collectModuleConstCallInitializers(ast: Program): Set<NodeLike> {
	const calls = new Set<NodeLike>()
	for (const statement of ast.body) {
		const candidate =
			statement.type === 'ExportNamedDeclaration'
				? object((statement as unknown as NodeLike).declaration)
				: (statement as unknown as NodeLike)
		if (candidate?.type !== 'VariableDeclaration' || candidate.kind !== 'const') continue
		for (const declaration of array(candidate.declarations)) {
			const initializer = object(declaration.init)
			if (initializer?.type === 'CallExpression') calls.add(initializer)
		}
	}
	return calls
}

function collectNodeModuleImports(ast: Program): Set<string> {
	const names = new Set<string>()
	for (const statement of ast.body) {
		if (
			statement.type !== 'ImportDeclaration' ||
			statement.source.value !== NODE_MODULE_IMPORT_SOURCE
		) {
			continue
		}
		for (const specifier of statement.specifiers) {
			if (specifier.type !== 'ImportSpecifier') continue
			const imported =
				specifier.imported.type === 'Identifier'
					? specifier.imported.name
					: String((specifier.imported as { value?: unknown }).value ?? '')
			if (imported === 'defineNodeModule' || imported === 'defineWorkerTask') {
				names.add(specifier.local.name)
			}
		}
	}
	return names
}

async function hashDependencyState(
	hash: ReturnType<typeof createHash>,
	root: string,
): Promise<void> {
	for (const file of findClosestDependencyStateFiles(root)) {
		hash.update(file)
		hash.update(await readFile(file))
	}
}

function findClosestDependencyStateFiles(start: string): string[] {
	const names = [
		'pnpm-lock.yaml',
		'pnpm-workspace.yaml',
		'package-lock.json',
		'yarn.lock',
		'bun.lock',
		'bun.lockb',
	]
	let current = resolve(start)
	for (let depth = 0; depth < 12; depth += 1) {
		const files = names.map((name) => resolve(current, name)).filter((file) => existsSync(file))
		if (files.length > 0) return files
		const parent = resolve(current, '..')
		if (parent === current) break
		current = parent
	}
	return []
}

function collectSourceImports(file: string, content: string): string[] {
	if (['.css', '.scss', '.sass', '.less'].includes(extname(file))) {
		return [
			...[...content.matchAll(/@(?:import|use|forward)\s+(?:url\()?['"]([^'"]+)['"]/g)].map(
				(match) => match[1]!,
			),
			...[...content.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)].map((match) => match[1]!),
		].filter((specifier) => !specifier.startsWith('#') && !specifier.startsWith('data:'))
	}
	const ast = parseStandaloneWithLang(content, file)
	return ast ? collectImportSpecifiers(ast).map((item) => item.specifier) : []
}

function resolveImport(
	importer: string,
	specifier: string,
	conditionNames?: readonly string[],
): { path: string; packageJsonPath?: string } | null {
	if (/^(?:https?:|data:|node:)/.test(specifier)) return null
	const hit = resolveWithOxc(dirname(importer), specifier, {
		conditionNames,
		extensions: [
			'.tsx',
			'.ts',
			'.jsx',
			'.js',
			'.mts',
			'.mjs',
			'.cts',
			'.cjs',
			'.css',
			'.scss',
			'.sass',
			'.less',
			'.json',
		],
		tsconfig: 'auto',
	})
	return hit ? { path: hit.path, packageJsonPath: hit.packageJsonPath } : null
}

function sourceSlice(code: string, node: unknown): string {
	const value = object(node)
	return value && typeof value.start === 'number' && typeof value.end === 'number'
		? code.slice(value.start, value.end).replaceAll(/\s+/g, '')
		: ''
}

function literalString(node: unknown): string | null {
	const value = object(node)
	return value?.type === 'Literal' && typeof value.value === 'string' ? value.value : null
}

function array(value: unknown): NodeLike[] {
	return Array.isArray(value)
		? value.map(object).filter((item): item is NodeLike => Boolean(item))
		: []
}

function object(value: unknown): NodeLike | null {
	return value && typeof value === 'object' ? (value as NodeLike) : null
}

function visitNode(node: unknown, visit: (node: NodeLike) => void): void {
	if (!node || typeof node !== 'object') return
	if (Array.isArray(node)) {
		for (const item of node) visitNode(item, visit)
		return
	}
	const current = node as NodeLike
	if (typeof current.type === 'string') visit(current)
	for (const [key, value] of Object.entries(current)) {
		if (['type', 'start', 'end', 'loc', 'range', 'comments'].includes(key)) continue
		if (value && typeof value === 'object') visitNode(value, visit)
	}
}
