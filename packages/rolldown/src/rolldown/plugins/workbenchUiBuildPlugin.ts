import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import {
	workbenchFederationBuildOutDir,
	workbenchFederationSharedPackages,
	sanitizeWorkbenchOwnerName,
} from '@pluxel/core/federation'
import type { Program } from 'oxc-parser'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'pathe'
import type { InlineConfig } from 'vite'
import { resolveWithOxc } from '../../resolver/oxc.ts'
import { validateWorkbenchUiArtifact } from '../../workbench/artifact.ts'
import {
	resolveWorkbenchFederationShared,
	resolveWorkbenchUiBuildSignature,
} from '../../workbench/build-contract.ts'
import { runWorkbenchOutputTransaction } from '../../workbench/build-scheduler.ts'
import { collectImportSpecifiers } from './importCollector.ts'
import { allowOptionalQuerySuffix, type ViteCompatPlugin } from './compat.ts'
import { normalizePatterns, parseStandaloneWithLang, parseWithLang } from './pluginUtils.ts'
import { normalizeViteId } from './viteNormalizeId.ts'

const WORKBENCH_UI_BUILD_CACHE_VERSION = 1
const ARTIFACT_STAMP_FILE = 'pluxel-workbench.json'
const CODE_HINT = /\bworkbench\s*\.\s*extension\s*\(/
const IMPORT_SOURCE = '@pluxel/runtime/workbench'
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

type ArtifactStamp = Readonly<{
	version: number
	pluginName: string
	sourceHash: string
}>

export type WorkbenchUiBuildPluginOptions = {
	root?: string
	buildDir?: string
	cacheDir?: string
	cacheKeep?: number
	sharedPackages?: readonly string[]
	minify?: boolean
	vite?: InlineConfig
	cacheKey?: string
	include?: string | string[]
	exclude?: string | string[]
	log?: (message: string) => void
}

export function workbenchUiBuildPlugin(
	options: WorkbenchUiBuildPluginOptions = {},
): ViteCompatPlugin {
	const root = resolve(options.root ?? process.cwd())
	const declarations = new Map<string, WorkbenchUiDeclaration>()
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
		name: 'pluxel-workbench-ui-build',
		enforce: 'pre',
		buildStart() {
			declarations.clear()
		},
		transform: {
			filter: {
				id: { include: includePatterns, exclude: excludePatterns },
			},
			handler(code, rawId) {
				if (!CODE_HINT.test(code)) return null
				const id = normalizeViteId(rawId)
				const ast = parseWithLang(this, code, id)
				if (!ast) this.error(`[workbench-ui] failed to parse declaration module: ${id}`)
				const extracted = extractWorkbenchUiDeclarations(ast, code, id, root)
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
				if (extracted.length === 0) return null
				let transformed = code
				for (const declaration of [...extracted].sort((a, b) => b.insertOffset - a.insertOffset)) {
					transformed = `${transformed.slice(0, declaration.insertOffset)}, ${JSON.stringify(
						declaration.pluginName,
					)}${transformed.slice(declaration.insertOffset)}`
				}
				return { code: transformed, map: null }
			},
		},
		async writeBundle() {
			if (declarations.size === 0) return
			await Promise.all(
				[...declarations.values()]
					.sort((a, b) => a.pluginName.localeCompare(b.pluginName))
					.map((declaration) => buildProductionRemote(root, declaration, options)),
			)
		},
	}
}

async function buildProductionRemote(
	root: string,
	declaration: WorkbenchUiDeclaration,
	options: WorkbenchUiBuildPluginOptions,
): Promise<void> {
	if (!existsSync(declaration.entryPath)) {
		throw new Error(`[workbench-ui] entry file not found: ${declaration.entryPath}`)
	}
	const sharedPackages = options.sharedPackages?.length
		? options.sharedPackages
		: workbenchFederationSharedPackages
	const sourceHash = await hashWorkbenchUiGraph(
		root,
		declaration,
		sharedPackages,
		[
			resolveWorkbenchFederationShared(root, sharedPackages).signature,
			resolveWorkbenchUiBuildSignature(options.vite, options.cacheKey),
		].join('\n'),
	)
	const outDir = resolve(
		root,
		workbenchFederationBuildOutDir(declaration.pluginName, options.buildDir ?? 'dist'),
	)
	const ownerCacheDir = resolve(
		root,
		options.cacheDir ?? '.pluxel/workbench-build',
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
				sharedPackages,
				minify: options.minify ?? true,
				vite: options.vite,
				cacheKey: options.cacheKey,
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
		await cleanupProductionCache(ownerCacheDir, Math.max(1, options.cacheKeep ?? 3), sourceHash)
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
		const pluginName = `artifact-${createHash('sha256')
			.update(`${relative(root, id)}\0${relativeEntry}`)
			.digest('hex')
			.slice(0, 12)}`
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
	sharedPackages: readonly string[],
	buildSignature: string,
): Promise<string> {
	const hash = createHash('sha256')
	hash.update(`workbench-ui-build:${WORKBENCH_UI_BUILD_CACHE_VERSION}`)
	hash.update(`plugin:${declaration.pluginName}`)
	hash.update(`shared:${[...sharedPackages].sort().join('|')}`)
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
