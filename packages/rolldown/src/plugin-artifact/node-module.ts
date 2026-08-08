import { builtinModules } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'pathe'
import type { Plugin } from 'vite'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/rollup'
import { collectImportSpecifiers } from '../rolldown/plugins/importCollector.ts'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils.ts'
import { resolveWithOxc } from '../resolver/oxc.ts'

export type BuildNodeModuleOptions = Readonly<{
	root: string
	entryPath: string
	outFile: string
	/** Minifies the generated single-file ESM artifact. @defaultValue false */
	minify?: boolean
}>

export type ValidateNodeModuleArtifactOptions = Readonly<{
	/** Fallback owner root when `entryPath` is outside a package. Defaults to the entry directory. */
	root?: string
	/** Re-analyzes source ownership so cached artifacts accept the same native residuals as builds. */
	entryPath?: string
}>

export type NodeModuleNativeResidual = Readonly<{
	name: string
	entryPath: string
}>

type NativeImportBridge = Readonly<{
	id: string
	name: string
	packageChain: readonly string[]
	namedExports: readonly string[]
}>

type NodeModuleSourceAnalysis = Readonly<{
	entryPackageName?: string
	entryPackageRoot: string
	residuals: readonly NodeModuleNativeResidual[]
	nativeImports: ReadonlyMap<string, NativeImportBridge>
}>

const forbiddenRuntimeImport = /^@pluxel\/(?:core|runtime)(?:\/|$)/
const forbiddenDeclaration =
	/\b(?:defineNodeModule|defineWorkerTask|workbench\s*\.\s*(?:entry|extension)|Plugin)\s*\(/
const sourceExtensions = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs', '.cts', '.cjs', '.json']
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
const nodeArtifactConditions = ['@pluxel/hmr', 'node', 'import', 'module', 'default']

/** Build a self-contained, single-file Node ESM artifact. */
export async function buildNodeModule(options: BuildNodeModuleOptions): Promise<void> {
	const root = resolve(options.root)
	const entryPath = resolve(options.entryPath)
	const outFile = resolve(options.outFile)
	const analysis = await analyzeNodeModuleSourceGraph(entryPath, root)
	await mkdir(dirname(outFile), { recursive: true })
	const vite = await loadVite()
	const fileName = basename(outFile)
	const stagingDir = `${outFile}.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	const stagedFile = join(stagingDir, fileName)
	try {
		await vite.build({
			configFile: false,
			root,
			logLevel: 'silent',
			plugins: [nativeImportBridgePlugin(analysis, outFile), PreprocessorDirectives()],
			resolve: {
				conditions: nodeArtifactConditions,
			},
			ssr: {
				noExternal: true,
				resolve: { conditions: nodeArtifactConditions },
			},
			build: {
				ssr: true,
				target: 'node24',
				outDir: stagingDir,
				emptyOutDir: true,
				minify: options.minify ?? false,
				sourcemap: false,
				rollupOptions: {
					input: entryPath,
					external: (id: string) => builtins.has(id),
					output: {
						format: 'es',
						codeSplitting: false,
						entryFileNames: fileName,
						chunkFileNames: fileName,
						assetFileNames: '[name][extname]',
					},
				},
			},
		})
		const outputs = await collectOutputFiles(stagingDir)
		if (outputs.length !== 1 || outputs[0] !== fileName) {
			throw new Error(
				`[node-module] build must emit exactly one ESM file; received: ${outputs.join(', ') || '(none)'}`,
			)
		}
		await validateNodeModuleOutput(stagedFile)
		await rename(stagedFile, outFile)
	} finally {
		await rm(stagingDir, { recursive: true, force: true })
	}
}

export async function validateNodeModuleArtifact(
	file: string,
	options: ValidateNodeModuleArtifactOptions = {},
): Promise<void> {
	if (options.entryPath) {
		await analyzeNodeModuleSourceGraph(
			resolve(options.entryPath),
			resolve(options.root ?? dirname(options.entryPath)),
		)
	}
	await validateNodeModuleOutput(resolve(file))
}

/** Resolve the package whose direct dependency contract owns a Node artifact entry. */
export function resolveNodeModuleDependencyRoot(entryPath: string, fallbackRoot: string): string {
	let current = dirname(resolve(entryPath))
	while (true) {
		if (existsSync(resolve(current, 'package.json'))) return current
		const parent = dirname(current)
		if (parent === current) return resolve(fallbackRoot)
		current = parent
	}
}

/** Resolve controlled native imports for static deployment tracing. */
export async function resolveNodeModuleNativeResiduals(
	entryPath: string,
	fallbackRoot: string,
): Promise<NodeModuleNativeResidual[]> {
	const analysis = await analyzeNodeModuleSourceGraph(resolve(entryPath), resolve(fallbackRoot))
	return [...analysis.residuals]
}

async function collectOutputFiles(root: string): Promise<string[]> {
	const files: string[] = []
	const queue = [root]
	while (queue.length > 0) {
		const dir = queue.shift()!
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) queue.push(path)
			else if (entry.isFile()) files.push(relative(root, path))
		}
	}
	return files.sort()
}

async function analyzeNodeModuleSourceGraph(
	entryPath: string,
	fallbackRoot: string,
): Promise<NodeModuleSourceAnalysis> {
	type GraphEntry = Readonly<{ file: string; packageChain: readonly string[] }>
	const entryPackageRoot = resolveNodeModuleDependencyRoot(entryPath, fallbackRoot)
	const queue: GraphEntry[] = [{ file: entryPath, packageChain: Object.freeze([]) }]
	const visited = new Set<string>()
	const nativeResiduals = new Map<string, string>()
	const nativeImports = new Map<string, NativeImportBridge>()
	const manifestCache = new Map<string, PackageDependencyContract>()
	while (queue.length > 0) {
		const current = queue.shift()!
		const file = resolve(current.file)
		if (visited.has(file)) continue
		visited.add(file)
		const ownerRoot = resolveNodeModuleDependencyRoot(file, fallbackRoot)
		if (isStyle(file)) {
			throw new Error(`[node-module] CSS and browser style assets are not supported: ${file}`)
		}
		const source = await readFile(file, 'utf8')
		const ast = parseStandaloneWithLang(source, file)
		if (!ast) throw new Error(`[node-module] failed to parse ${file}`)
		if (forbiddenDeclaration.test(source)) {
			throw new Error(`[node-module] nested Pluxel declarations are not allowed: ${file}`)
		}
		const typeOnly = new Set<string>()
		const valueImports = new Set<string>()
		for (const statement of ast.body) {
			if (
				statement.type !== 'ImportDeclaration' &&
				statement.type !== 'ExportNamedDeclaration' &&
				statement.type !== 'ExportAllDeclaration'
			)
				continue
			const specifier = (statement as unknown as { source?: { value?: unknown } }).source?.value
			if (typeof specifier !== 'string') continue
			if (isTypeOnlyModuleStatement(statement)) typeOnly.add(specifier)
			else valueImports.add(specifier)
		}
		for (const item of collectImportSpecifiers(ast)) {
			if (typeOnly.has(item.specifier) && !valueImports.has(item.specifier)) continue
			if (forbiddenRuntimeImport.test(item.specifier)) {
				throw new Error(`[node-module] value import of ${item.specifier} is forbidden in ${file}`)
			}
			if (isStyle(item.specifier)) {
				throw new Error(
					`[node-module] CSS and browser style assets are not supported: ${item.specifier}`,
				)
			}
			if (/^(?:node:|data:|https?:)/.test(item.specifier) || builtins.has(item.specifier)) continue
			const packageName = readPackageName(item.specifier)
			const hit = resolveWithOxc(dirname(file), item.specifier, {
				conditionNames: nodeArtifactConditions,
				extensions: sourceExtensions,
				tsconfig: 'auto',
			})
			const native = Boolean(
				hit?.path &&
				(extname(hit.path) === '.node' ||
					(hit.packageJsonPath && (await hasNativeMetadata(hit.packageJsonPath)))),
			)
			if (native) {
				if (!packageName || !hit?.path) {
					throw new Error(
						`[node-module] native file imports must cross a declared package boundary: ${item.specifier}`,
					)
				}
				const owner = await readPackageDependencyContract(ownerRoot, manifestCache)
				if (!owner.dependencies.has(packageName)) {
					throw new Error(
						`[node-module] native dependency ${packageName} must be declared directly in ${owner.name ?? ownerRoot} dependencies`,
					)
				}
				const existing = nativeResiduals.get(packageName)
				if (existing && existing !== hit.path) {
					throw new Error(
						`[node-module] native dependency ${packageName} resolves to multiple package entries`,
					)
				}
				nativeResiduals.set(packageName, hit.path)
				if (item.kind === 'dynamic') {
					throw new Error(
						`[node-module] dynamic imports of native dependency ${packageName} are not supported; use a static import`,
					)
				}
				const importKey = nativeImportKey(file, item.specifier)
				let bridge = nativeImports.get(importKey)
				if (!bridge) {
					bridge = Object.freeze({
						id: `\0pluxel-native-import:${nativeImports.size}`,
						name: packageName,
						packageChain: Object.freeze([...current.packageChain]),
						namedExports: readNativeNamedExports(ast.body, item.specifier, file),
					})
					nativeImports.set(importKey, bridge)
				}
				continue
			}
			if (hit?.path && !visited.has(hit.path)) {
				const dependencyRoot = hit.packageJsonPath
					? dirname(hit.packageJsonPath)
					: resolveNodeModuleDependencyRoot(hit.path, fallbackRoot)
				if (dependencyRoot !== ownerRoot && !packageName) {
					throw new Error(
						`[node-module] package boundaries must be crossed through a declared package import: ${item.specifier}`,
					)
				}
				queue.push({
					file: hit.path,
					packageChain:
						dependencyRoot === ownerRoot || !packageName
							? current.packageChain
							: Object.freeze([...current.packageChain, packageName]),
				})
			}
		}
	}
	const entryPackage = await readPackageDependencyContract(entryPackageRoot, manifestCache)
	const residuals = [...nativeResiduals]
		.map(([name, resolvedEntry]) => Object.freeze({ name, entryPath: resolvedEntry }))
		.toSorted((left, right) => left.name.localeCompare(right.name))
	return Object.freeze({
		...(entryPackage.name ? { entryPackageName: entryPackage.name } : {}),
		entryPackageRoot,
		residuals: Object.freeze(residuals),
		nativeImports,
	})
}

function nativeImportBridgePlugin(analysis: NodeModuleSourceAnalysis, outFile: string): Plugin {
	type BridgeGroup = {
		readonly id: string
		readonly name: string
		readonly packageChain: readonly string[]
		readonly namedExports: Set<string>
	}
	const groupsByKey = new Map<string, BridgeGroup>()
	const groupIdsByImportId = new Map<string, string>()
	for (const bridge of analysis.nativeImports.values()) {
		const key = JSON.stringify([bridge.name, bridge.packageChain])
		let group = groupsByKey.get(key)
		if (!group) {
			group = {
				id: `\0pluxel-native-bridge:${groupsByKey.size}`,
				name: bridge.name,
				packageChain: bridge.packageChain,
				namedExports: new Set(),
			}
			groupsByKey.set(key, group)
		}
		for (const name of bridge.namedExports) group.namedExports.add(name)
		groupIdsByImportId.set(bridge.id, group.id)
	}
	const bridgesById = new Map([...groupsByKey.values()].map((bridge) => [bridge.id, bridge]))
	const entryManifest = resolve(analysis.entryPackageRoot, 'package.json')
	const fallbackUrl = relativeModuleUrl(outFile, entryManifest)
	return {
		name: 'pluxel-native-import-bridge',
		enforce: 'pre',
		resolveId(source, importer) {
			if (!importer) return null
			const bridge = analysis.nativeImports.get(
				nativeImportKey(normalizeModuleId(importer), source),
			)
			return bridge ? groupIdsByImportId.get(bridge.id) : null
		},
		load(id) {
			const bridge = bridgesById.get(id)
			if (!bridge) return null
			const entryLookup = analysis.entryPackageName
				? `__existsSync(__fallback) ? __fallback : (() => { try { return __findPackageJSON(${JSON.stringify(analysis.entryPackageName)}, import.meta.url) ?? __fallback } catch { return __fallback } })()`
				: '__fallback'
			const chain = bridge.packageChain
				.map((name) => `__owner = __findPackage(${JSON.stringify(name)}, __owner);`)
				.join('\n')
			const names = [...bridge.namedExports].sort()
			const namedExports = names
				.map((name, index) => `const __nativeExport${index} = __native[${JSON.stringify(name)}];`)
				.join('\n')
			const exportList = names.map((name, index) => `__nativeExport${index} as ${name}`).join(', ')
			return {
				code: [
					`import { existsSync as __existsSync } from 'node:fs';`,
					`import { createRequire as __createRequire, findPackageJSON as __findPackageJSON } from 'node:module';`,
					`const __fallback = new URL(${JSON.stringify(fallbackUrl)}, import.meta.url);`,
					`const __findPackage = (name, base) => { const manifest = __findPackageJSON(name, base); if (!manifest) throw new Error(\`Cannot resolve native owner package \${name}\`); return manifest; };`,
					`let __owner = ${entryLookup};`,
					chain,
					`const __native = __createRequire(__owner)(${JSON.stringify(bridge.name)});`,
					namedExports,
					`export default __native;`,
					exportList ? `export { ${exportList} };` : '',
				]
					.filter(Boolean)
					.join('\n'),
			}
		},
	}
}

function nativeImportKey(importer: string, specifier: string): string {
	return `${resolve(importer)}\0${specifier}`
}

function readNativeNamedExports(
	body: readonly unknown[],
	specifier: string,
	file: string,
): readonly string[] {
	const names = new Set<string>()
	for (const value of body) {
		if (!value || typeof value !== 'object') continue
		const statement = value as {
			type?: unknown
			source?: { value?: unknown }
			importKind?: unknown
			exportKind?: unknown
			specifiers?: Array<{
				type?: unknown
				importKind?: unknown
				exportKind?: unknown
				imported?: unknown
				local?: unknown
			}>
		}
		if (statement.source?.value !== specifier) continue
		if (statement.type === 'ExportAllDeclaration') {
			throw new Error(
				`[node-module] export * from native dependency ${specifier} is not supported in ${file}`,
			)
		}
		if (statement.type !== 'ImportDeclaration' && statement.type !== 'ExportNamedDeclaration') {
			continue
		}
		if (statement.importKind === 'type' || statement.exportKind === 'type') continue
		for (const item of statement.specifiers ?? []) {
			if (item.importKind === 'type' || item.exportKind === 'type') continue
			if (item.type === 'ImportNamespaceSpecifier') {
				throw new Error(
					`[node-module] namespace imports of native dependency ${specifier} are not supported in ${file}; use named imports`,
				)
			}
			if (item.type === 'ImportDefaultSpecifier') continue
			const name = readModuleExportName(
				item.type === 'ImportSpecifier' ? item.imported : item.local,
			)
			if (!name || name === 'default') continue
			if (!/^[A-Za-z_$][\w$]*$/u.test(name)) {
				throw new Error(
					`[node-module] native dependency export ${JSON.stringify(name)} is not a supported identifier`,
				)
			}
			names.add(name)
		}
	}
	return Object.freeze([...names].sort())
}

function readModuleExportName(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined
	const node = value as { name?: unknown; value?: unknown }
	return typeof node.name === 'string'
		? node.name
		: typeof node.value === 'string'
			? node.value
			: undefined
}

function normalizeModuleId(id: string): string {
	const query = id.indexOf('?')
	return query < 0 ? id : id.slice(0, query)
}

function relativeModuleUrl(fromFile: string, toFile: string): string {
	const path = relative(dirname(fromFile), toFile)
	const encoded = path
		.split('/')
		.map((segment) => (segment === '.' || segment === '..' ? segment : encodeURIComponent(segment)))
		.join('/')
	return encoded.startsWith('.') ? encoded : `./${encoded}`
}

type PackageDependencyContract = Readonly<{
	name?: string
	dependencies: ReadonlySet<string>
}>

async function readPackageDependencyContract(
	root: string,
	cache: Map<string, PackageDependencyContract>,
): Promise<PackageDependencyContract> {
	const existing = cache.get(root)
	if (existing) return existing
	let manifest: {
		name?: unknown
		dependencies?: Record<string, unknown>
		optionalDependencies?: Record<string, unknown>
	} = {}
	try {
		manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as typeof manifest
	} catch {
		// The missing/invalid owner manifest is reported as an undeclared native dependency below.
	}
	const contract = Object.freeze({
		...(typeof manifest.name === 'string' ? { name: manifest.name } : {}),
		dependencies: new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
		]),
	})
	cache.set(root, contract)
	return contract
}

function isTypeOnlyModuleStatement(statement: unknown): boolean {
	const module = statement as {
		importKind?: string
		exportKind?: string
		specifiers?: Array<{ importKind?: string; exportKind?: string }>
	}
	if (module.importKind === 'type' || module.exportKind === 'type') return true
	return Boolean(
		module.specifiers?.length &&
		module.specifiers.every(
			(specifier) => specifier.importKind === 'type' || specifier.exportKind === 'type',
		),
	)
}

async function validateNodeModuleOutput(outFile: string): Promise<void> {
	const output = await readFile(outFile, 'utf8')
	const ast = parseStandaloneWithLang(output, outFile)
	if (!ast) throw new Error(`[node-module] generated artifact is not valid ESM: ${outFile}`)
	for (const { specifier } of collectImportSpecifiers(ast)) {
		if (builtins.has(specifier)) continue
		throw new Error(
			`[node-module] generated artifact is not self-contained; unresolved import: ${specifier}`,
		)
	}
}

async function hasNativeMetadata(packageJson: string): Promise<boolean> {
	try {
		const metadata = JSON.parse(await readFile(packageJson, 'utf8')) as {
			napi?: unknown
			binary?: unknown
			gypfile?: unknown
		}
		return Boolean(
			(metadata.napi && typeof metadata.napi === 'object') ||
			metadata.binary !== undefined ||
			metadata.gypfile === true,
		)
	} catch {
		// The package manager/build reports invalid dependency metadata separately.
		return false
	}
}

function readPackageName(specifier: string): string | null {
	if (
		!specifier ||
		specifier.startsWith('.') ||
		specifier.startsWith('/') ||
		specifier.includes(':')
	) {
		return null
	}
	const parts = specifier.split('/')
	return specifier.startsWith('@') && parts.length >= 2
		? `${parts[0]}/${parts[1]}`
		: parts[0] || null
}

function isStyle(path: string): boolean {
	return ['.css', '.scss', '.sass', '.less', '.styl', '.stylus'].includes(extname(path))
}

async function loadVite(): Promise<typeof import('vite')> {
	try {
		return await import('vite')
	} catch (error) {
		throw new Error(
			'[node-module] building a declared Node module requires Vite. Install it as a development dependency.',
			{ cause: error },
		)
	}
}
