import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { workbenchFederationBuildOutDir, sanitizeWorkbenchOwnerName } from '@pluxel/core/federation'
import type { Program } from 'oxc-parser'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'pathe'
import {
	findDatabasePackageRoot,
	loadDatabaseArtifactForSource,
	type DatabaseBuildArtifact,
} from '../../database/artifact.ts'
import { extractDatabaseDeclarations } from '../../database/declaration.ts'
import { generateResetDatabaseArtifact } from '../../database/reset-artifact.ts'
import { resolveWithOxc } from '../../resolver/oxc.ts'
import { validateWorkbenchUiArtifact } from '../../workbench/artifact.ts'
import { resolveWorkbenchFederationShared } from '../../workbench/build-contract.ts'
import { runWorkbenchOutputTransaction } from '../../workbench/build-scheduler.ts'
import { collectImportSpecifiers } from './importCollector.ts'
import { allowOptionalQuerySuffix, type ViteCompatPlugin } from './compat.ts'
import { normalizePatterns, parseStandaloneWithLang, parseWithLang } from './pluginUtils.ts'
import { normalizeViteId } from './viteNormalizeId.ts'
import {
	resolveNodeModuleBuildSignature,
	resolvePluginArtifactKey,
} from '../../vite/declaration.ts'

const WORKBENCH_UI_BUILD_CACHE_VERSION = 2
const NODE_MODULE_BUILD_CACHE_VERSION = 1
const PRODUCTION_ARTIFACT_CACHE_KEEP = 3
const ARTIFACT_STAMP_FILE = 'pluxel-workbench.json'
const CODE_HINT = /\b(?:workbench\s*\.\s*extension\s*\(|defineNodeModule\s*\(|defineWorkerTask\b)/
const DATABASE_CODE_HINT = /\bdefineDatabase\s*\(/
const IMPORT_SOURCE = '@pluxel/runtime/workbench'
const NODE_MODULE_IMPORT_SOURCE = '@pluxel/runtime'
const productionBuilds = new Map<string, Promise<void>>()

type NodeLike = {
	type?: unknown
	start?: unknown
	end?: unknown
	[key: string]: unknown
}

type WorkbenchUiDeclaration = Readonly<{
	pluginName: string
	entryPath: string
	insertOffset: number
}>

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

type ArtifactStamp = Readonly<{
	version: number
	pluginName: string
	sourceHash: string
}>

export type PluginArtifactBuildPluginOptions = {
	root?: string
	buildDir?: string
	workbench?:
		| false
		| {
				minify?: boolean
		  }
	node?: {
		minify?: boolean
		/** @internal Reports controlled native imports to the static deployment tracer. */
		onNativeResidual?: (name: string, resolvedEntry: string) => void
		/** @internal Clears native residual facts at the next build generation. */
		onNativeResidualReset?: () => void
	}
	include?: string | string[]
	exclude?: string | string[]
	log?: (message: string) => void
}

export function pluginArtifactBuildPlugin(
	options: PluginArtifactBuildPluginOptions = {},
): ViteCompatPlugin {
	const root = resolve(options.root ?? process.cwd())
	const declarations = new Map<string, WorkbenchUiDeclaration>()
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
			declarations.clear()
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
				const extracted =
					options.workbench === false ? [] : extractWorkbenchUiDeclarations(ast, code, id, root)
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
				for (const declaration of extracted) {
					const existing = declarations.get(declaration.pluginName)
					if (existing && existing.entryPath !== declaration.entryPath) {
						this.error(
							`[workbench-ui] plugin ${declaration.pluginName} declares multiple UI entries: ` +
								`${existing.entryPath} and ${declaration.entryPath}`,
						)
					}
					declarations.set(declaration.pluginName, declaration)
				}
				for (const declaration of extractedNode) {
					const existing = nodeDeclarations.get(declaration.artifactKey)
					if (existing && existing.entryPath !== declaration.entryPath) {
						this.error(`[node-module] artifact key collision: ${declaration.artifactKey}`)
					}
					nodeDeclarations.set(declaration.artifactKey, declaration)
				}
				if (
					extracted.length === 0 &&
					extractedNode.length === 0 &&
					databaseDeclarations.length === 0
				)
					return null
				let transformed = code
				const lowerings = [
					...extracted.map((item) => ({
						value: injectedArgument(code, item.insertOffset, JSON.stringify(item.pluginName)),
						offset: item.insertOffset,
					})),
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
			await Promise.all([
				...[...declarations.values()]
					.sort((a, b) => a.pluginName.localeCompare(b.pluginName))
					.map((declaration) => buildProductionRemote(root, declaration, options)),
				...[...nodeDeclarations.values()]
					.sort((a, b) => a.artifactKey.localeCompare(b.artifactKey))
					.map((declaration) => buildProductionNodeModule(root, declaration, options)),
				...(databasePackages.get(root)
					? [copyDatabaseMigrations(databasePackages.get(root)!.migrationsDir, root, options)]
					: []),
			])
		},
		async closeBundle() {
			await cleanupGeneratedDatabaseArtifacts(databasePackages)
			databasePackages.clear()
		},
	}
}

function injectedArgument(code: string, insertOffset: number, value: string): string {
	let index = insertOffset - 1
	while (index >= 0 && /\s/u.test(code[index]!)) index--
	return code[index] === ',' ? ` ${value}` : `, ${value}`
}

async function buildProductionRemote(
	root: string,
	declaration: WorkbenchUiDeclaration,
	options: PluginArtifactBuildPluginOptions,
): Promise<void> {
	if (!existsSync(declaration.entryPath)) {
		throw new Error(`[workbench-ui] entry file not found: ${declaration.entryPath}`)
	}
	const target = options.workbench === false ? {} : (options.workbench ?? {})
	const sourceHash = await hashWorkbenchUiGraph(
		root,
		declaration,
		resolveWorkbenchFederationShared(root).signature,
	)
	const outDir = resolve(
		root,
		workbenchFederationBuildOutDir(declaration.pluginName, options.buildDir ?? 'dist'),
	)
	const ownerCacheDir = resolve(
		root,
		'.pluxel/workbench-build',
		sanitizeWorkbenchOwnerName(declaration.pluginName),
	)
	const cachedOutDir = join(ownerCacheDir, sourceHash)
	const key = `${cachedOutDir}\u0000${sourceHash}`
	const existing = productionBuilds.get(key)
	if (existing) return existing

	const task = runWorkbenchOutputTransaction(outDir, async () => {
		if (await canReuseArtifact(cachedOutDir, declaration.pluginName, sourceHash)) {
			options.log?.(`[workbench-ui] reuse ${declaration.pluginName} (${sourceHash})`)
		} else {
			options.log?.(`[workbench-ui] build ${declaration.pluginName} (${sourceHash})`)
			const buildTools = await loadWorkbenchUiBuildTools()
			await buildTools.buildWorkbenchUiRemote({
				root,
				pluginName: declaration.pluginName,
				entryPath: declaration.entryPath,
				outDir: cachedOutDir,
				minify: target.minify ?? true,
				sourcemap: false,
			})
			await writeFile(
				join(cachedOutDir, ARTIFACT_STAMP_FILE),
				`${JSON.stringify({
					version: WORKBENCH_UI_BUILD_CACHE_VERSION,
					pluginName: declaration.pluginName,
					sourceHash,
				} satisfies ArtifactStamp)}\n`,
				'utf-8',
			)
		}
		await publishCachedArtifact(cachedOutDir, outDir)
		await cleanupProductionCache(ownerCacheDir, PRODUCTION_ARTIFACT_CACHE_KEEP, sourceHash)
	})

	productionBuilds.set(key, task)
	try {
		await task
	} finally {
		if (productionBuilds.get(key) === task) productionBuilds.delete(key)
	}
}

async function loadWorkbenchUiBuildTools(): Promise<typeof import('../../vite/workbench-ui.ts')> {
	try {
		return await import('../../vite/workbench-ui.ts')
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
		const buildTools = await import('../../vite/node-module.ts')
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
					root: buildTools.resolveNodeModuleDependencyRoot(declaration.entryPath, root),
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
			const hit = resolveImport(file, specifier)
			if (hit?.path && existsSync(hit.path)) queue.push(hit.path)
		}
	}
	return hash.digest('hex').slice(0, 16)
}

async function publishCachedArtifact(source: string, target: string): Promise<void> {
	const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	const staged = `${target}.tmp-${nonce}`
	const previous = `${target}.previous-${nonce}`
	await rm(staged, { recursive: true, force: true })
	await mkdir(dirname(staged), { recursive: true })
	await cp(source, staged, { recursive: true, force: true })
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

async function cleanupProductionCache(
	ownerCacheDir: string,
	keep: number,
	currentHash: string,
): Promise<void> {
	const entries = await readdir(ownerCacheDir).catch((): string[] => [])
	const builds: Array<{ name: string; mtime: number }> = []
	for (const name of entries) {
		if (name === currentHash) continue
		const fileStat = await stat(join(ownerCacheDir, name, ARTIFACT_STAMP_FILE)).catch(
			(): null => null,
		)
		if (fileStat?.isFile()) builds.push({ name, mtime: fileStat.mtimeMs })
	}
	builds.sort((a, b) => b.mtime - a.mtime)
	for (const stale of builds.slice(Math.max(0, keep - 1))) {
		await rm(join(ownerCacheDir, stale.name), { recursive: true, force: true })
	}
}

async function canReuseArtifact(
	outDir: string,
	pluginName: string,
	sourceHash: string,
): Promise<boolean> {
	let stamp: ArtifactStamp
	try {
		stamp = JSON.parse(await readFile(join(outDir, ARTIFACT_STAMP_FILE), 'utf-8')) as ArtifactStamp
	} catch {
		return false
	}
	if (
		stamp.version !== WORKBENCH_UI_BUILD_CACHE_VERSION ||
		stamp.pluginName !== pluginName ||
		stamp.sourceHash !== sourceHash
	) {
		return false
	}
	const validation = await validateWorkbenchUiArtifact(outDir, pluginName)
	return validation.valid
}

function extractWorkbenchUiDeclarations(
	ast: Program,
	code: string,
	id: string,
	root: string,
): WorkbenchUiDeclaration[] {
	const namespaces = collectAuthoringImports(ast)
	if (namespaces.size === 0) return []
	const out: WorkbenchUiDeclaration[] = []
	visitNode(ast as unknown as NodeLike, (node) => {
		if (node.type !== 'CallExpression') return
		const namespace = [...namespaces].find(
			(local) => sourceSlice(code, node.callee) === `${local}.extension`,
		)
		if (!namespace) return
		const args = array(node.arguments)
		const input = args[0]
		if (!input || input.type !== 'ObjectExpression') return
		const entry = readObjectProperty(input, 'entry')
		if (!entry) return
		if (
			entry.type !== 'CallExpression' ||
			sourceSlice(code, entry.callee) !== `${namespace}.entry`
		) {
			throw new Error(
				`[workbench-ui] extension.entry must call workbench.entry() directly in ${id}`,
			)
		}
		const entryArgs = array(entry.arguments)
		if (entryArgs.length !== 2 || sourceSlice(code, entryArgs[0]) !== 'import.meta.url') {
			throw new Error(
				`[workbench-ui] extension must declare workbench.entry(import.meta.url, "./ui-entry") in ${id}`,
			)
		}
		const relativeEntry = literalString(entryArgs[1])
		if (!relativeEntry) {
			throw new Error(`[workbench-ui] UI entry must be a string literal in ${id}`)
		}
		const pluginName = resolvePluginArtifactKey('workbench', root, id, relativeEntry)
		const insertOffset = Number(entry.end) - 1
		if (!Number.isInteger(insertOffset) || insertOffset < 0) {
			throw new Error(`[workbench-ui] cannot locate workbench.entry() call in ${id}`)
		}
		out.push({
			pluginName,
			entryPath: isAbsolute(relativeEntry)
				? resolve(relativeEntry)
				: resolve(dirname(id), relativeEntry),
			insertOffset,
		})
	})
	return out
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
		const artifactKey = resolvePluginArtifactKey('node', root, id, relativeEntry)
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

function collectAuthoringImports(ast: Program): Set<string> {
	const namespaces = new Set<string>()
	for (const statement of ast.body) {
		if (statement.type !== 'ImportDeclaration' || statement.source.value !== IMPORT_SOURCE) continue
		for (const specifier of statement.specifiers) {
			if (specifier.type !== 'ImportSpecifier') continue
			const imported =
				specifier.imported.type === 'Identifier'
					? specifier.imported.name
					: String((specifier.imported as { value?: unknown }).value ?? '')
			if (imported === 'workbench') namespaces.add(specifier.local.name)
		}
	}
	return namespaces
}

async function hashWorkbenchUiGraph(
	root: string,
	declaration: WorkbenchUiDeclaration,
	buildSignature: string,
): Promise<string> {
	const hash = createHash('sha256')
	hash.update(`workbench-ui-build:${WORKBENCH_UI_BUILD_CACHE_VERSION}`)
	hash.update(`plugin:${declaration.pluginName}`)
	hash.update(`build:${buildSignature}`)
	const queue = [declaration.entryPath]
	const visited = new Set<string>()
	const dependencyMetadata = new Set<string>()
	await hashDependencyState(hash, root)

	while (queue.length > 0) {
		const file = resolve(queue.shift()!)
		if (visited.has(file)) continue
		visited.add(file)
		const content = await readFile(file, 'utf-8')
		hash.update(relative(root, file))
		hash.update(content)

		for (const specifier of collectSourceImports(file, content)) {
			const resolved = resolveImport(file, specifier)
			if (!resolved) continue
			if (resolved.packageJsonPath && resolved.path.includes('/node_modules/')) {
				dependencyMetadata.add(resolved.packageJsonPath)
				continue
			}
			if (existsSync(resolved.path)) queue.push(resolved.path)
		}
	}

	for (const packageJson of [...dependencyMetadata].sort()) {
		hash.update(packageJson)
		hash.update(await readFile(packageJson, 'utf-8').catch(() => ''))
	}
	return hash.digest('hex').slice(0, 16)
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
): { path: string; packageJsonPath?: string } | null {
	if (/^(?:https?:|data:|node:)/.test(specifier)) return null
	const hit = resolveWithOxc(dirname(importer), specifier, {
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

function readObjectProperty(node: NodeLike, key: string): NodeLike | null {
	for (const property of array(node.properties)) {
		if (property.type !== 'Property') continue
		const propertyKey = identifierName(property.key) ?? literalString(property.key)
		if (propertyKey === key) return object(property.value)
	}
	return null
}

function sourceSlice(code: string, node: NodeLike | undefined): string {
	return node && typeof node.start === 'number' && typeof node.end === 'number'
		? code.slice(node.start, node.end).replaceAll(/\s+/g, '')
		: ''
}

function identifierName(node: unknown): string | null {
	return object(node)?.type === 'Identifier' && typeof object(node)?.name === 'string'
		? (object(node)!.name as string)
		: null
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
