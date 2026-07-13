import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import {
	managementFederationBuildOutDir,
	managementFederationSharedPackages,
	sanitizeManagementOwnerName,
} from '@pluxel/core/federation'
import type { Program } from 'oxc-parser'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'pathe'
import type { InlineConfig } from 'vite'
import { resolveWithOxc } from '../../resolver/oxc.ts'
import { validateManagementUiArtifact } from '../../management/artifact.ts'
import {
	resolveManagementFederationShared,
	resolveManagementUiBuildSignature,
} from '../../management/build-contract.ts'
import { collectImportSpecifiers } from './importCollector.ts'
import { allowOptionalQuerySuffix, type ViteCompatPlugin } from './compat.ts'
import { normalizePatterns, parseStandaloneWithLang, parseWithLang } from './pluginUtils.ts'
import { normalizeViteId } from './viteNormalizeId.ts'

const MANAGEMENT_UI_BUILD_CACHE_VERSION = 1
const ARTIFACT_STAMP_FILE = 'pluxel-management.json'
const CODE_HINT = /\bdefineManagementModule\s*\(|\bmanagementUi\s*\(/
const IMPORT_SOURCE = '@pluxel/runtime/management'
const productionBuilds = new Map<string, Promise<void>>()

type NodeLike = {
	type?: unknown
	start?: unknown
	end?: unknown
	[key: string]: unknown
}

type ManagementUiDeclaration = Readonly<{
	pluginName: string
	entryPath: string
}>

type ArtifactStamp = Readonly<{
	version: number
	pluginName: string
	sourceHash: string
}>

export type ManagementUiBuildPluginOptions = {
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

export function managementUiBuildPlugin(
	options: ManagementUiBuildPluginOptions = {},
): ViteCompatPlugin {
	const root = resolve(options.root ?? process.cwd())
	const declarations = new Map<string, ManagementUiDeclaration>()
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
		name: 'pluxel-management-ui-build',
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
				if (!ast) this.error(`[management-ui] failed to parse declaration module: ${id}`)
				for (const declaration of extractManagementUiDeclarations(ast, code, id)) {
					const existing = declarations.get(declaration.pluginName)
					if (existing && existing.entryPath !== declaration.entryPath) {
						this.error(
							`[management-ui] plugin ${declaration.pluginName} declares multiple UI entries: ` +
								`${existing.entryPath} and ${declaration.entryPath}`,
						)
					}
					declarations.set(declaration.pluginName, declaration)
				}
				return null
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
	declaration: ManagementUiDeclaration,
	options: ManagementUiBuildPluginOptions,
): Promise<void> {
	if (!existsSync(declaration.entryPath)) {
		throw new Error(`[management-ui] entry file not found: ${declaration.entryPath}`)
	}
	const sharedPackages = options.sharedPackages?.length
		? options.sharedPackages
		: managementFederationSharedPackages
	const sourceHash = await hashManagementUiGraph(
		root,
		declaration,
		sharedPackages,
		[
			resolveManagementFederationShared(root, sharedPackages).signature,
			resolveManagementUiBuildSignature(options.vite, options.cacheKey),
		].join('\n'),
	)
	const outDir = resolve(
		root,
		managementFederationBuildOutDir(declaration.pluginName, options.buildDir ?? 'dist'),
	)
	const ownerCacheDir = resolve(
		root,
		options.cacheDir ?? '.pluxel/management-build',
		sanitizeManagementOwnerName(declaration.pluginName),
	)
	const cachedOutDir = join(ownerCacheDir, sourceHash)
	const key = `${cachedOutDir}\u0000${sourceHash}`
	const existing = productionBuilds.get(key)
	if (existing) return existing

	const task = (async () => {
		if (await canReuseArtifact(cachedOutDir, declaration.pluginName, sourceHash)) {
			options.log?.(`[management-ui] reuse ${declaration.pluginName} (${sourceHash})`)
		} else {
			options.log?.(`[management-ui] build ${declaration.pluginName} (${sourceHash})`)
			const buildTools = await loadManagementUiBuildTools()
			await buildTools.buildManagementUiRemote({
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
					version: MANAGEMENT_UI_BUILD_CACHE_VERSION,
					pluginName: declaration.pluginName,
					sourceHash,
				} satisfies ArtifactStamp)}\n`,
				'utf-8',
			)
		}
		await publishCachedArtifact(cachedOutDir, outDir)
		await cleanupProductionCache(ownerCacheDir, Math.max(1, options.cacheKeep ?? 3), sourceHash)
	})()

	productionBuilds.set(key, task)
	try {
		await task
	} finally {
		if (productionBuilds.get(key) === task) productionBuilds.delete(key)
	}
}

async function loadManagementUiBuildTools(): Promise<typeof import('../../vite/management-ui.ts')> {
	try {
		return await import('../../vite/management-ui.ts')
	} catch (error) {
		throw new Error(
			'[management-ui] building a declared UI requires Vite. Install it in the plugin package with `pnpm add -D vite`.',
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
		stamp.version !== MANAGEMENT_UI_BUILD_CACHE_VERSION ||
		stamp.pluginName !== pluginName ||
		stamp.sourceHash !== sourceHash
	) {
		return false
	}
	const validation = await validateManagementUiArtifact(outDir, pluginName)
	return validation.valid
}

function extractManagementUiDeclarations(
	ast: Program,
	code: string,
	id: string,
): ManagementUiDeclaration[] {
	const imports = collectAuthoringImports(ast)
	if (imports.modules.size === 0 || imports.ui.size === 0) return []
	const out: ManagementUiDeclaration[] = []
	visitNode(ast as unknown as NodeLike, (node) => {
		if (node.type !== 'CallExpression') return
		const callee = identifierName(node.callee)
		if (!callee || !imports.modules.has(callee)) return
		const args = array(node.arguments)
		const input = args[0]
		if (!input || input.type !== 'ObjectExpression') return
		const pluginName = literalString(readObjectProperty(input, 'id'))
		if (!pluginName) {
			throw new Error(`[management-ui] defineManagementModule id must be a string literal in ${id}`)
		}
		const ui = readObjectProperty(input, 'ui')
		if (!ui) return
		if (ui.type !== 'CallExpression' || !imports.ui.has(identifierName(ui.callee) ?? '')) {
			throw new Error(`[management-ui] ${pluginName}.ui must call managementUi() directly`)
		}
		const uiArgs = array(ui.arguments)
		if (uiArgs.length !== 2 || sourceSlice(code, uiArgs[0]) !== 'import.meta.url') {
			throw new Error(
				`[management-ui] ${pluginName} must declare managementUi(import.meta.url, "./ui-entry")`,
			)
		}
		const relativeEntry = literalString(uiArgs[1])
		if (!relativeEntry) {
			throw new Error(`[management-ui] ${pluginName} UI entry must be a string literal`)
		}
		out.push({
			pluginName,
			entryPath: isAbsolute(relativeEntry)
				? resolve(relativeEntry)
				: resolve(dirname(id), relativeEntry),
		})
	})
	return out
}

function collectAuthoringImports(ast: Program): { modules: Set<string>; ui: Set<string> } {
	const modules = new Set<string>()
	const ui = new Set<string>()
	for (const statement of ast.body) {
		if (statement.type !== 'ImportDeclaration' || statement.source.value !== IMPORT_SOURCE) continue
		for (const specifier of statement.specifiers) {
			if (specifier.type !== 'ImportSpecifier') continue
			const imported =
				specifier.imported.type === 'Identifier'
					? specifier.imported.name
					: String((specifier.imported as { value?: unknown }).value ?? '')
			if (imported === 'defineManagementModule') modules.add(specifier.local.name)
			if (imported === 'managementUi') ui.add(specifier.local.name)
		}
	}
	return { modules, ui }
}

async function hashManagementUiGraph(
	root: string,
	declaration: ManagementUiDeclaration,
	sharedPackages: readonly string[],
	buildSignature: string,
): Promise<string> {
	const hash = createHash('sha256')
	hash.update(`management-ui-build:${MANAGEMENT_UI_BUILD_CACHE_VERSION}`)
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
