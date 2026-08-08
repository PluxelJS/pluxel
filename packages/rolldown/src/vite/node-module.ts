import { builtinModules } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'pathe'
import PreprocessorDirectives from 'unplugin-preprocessor-directives/rollup'
import { collectImportSpecifiers } from '../rolldown/plugins/importCollector.ts'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils.ts'
import { resolveWithOxc } from '../resolver/oxc.ts'

export type BuildNodeModuleOptions = Readonly<{
	root: string
	entryPath: string
	outFile: string
	minify?: boolean
}>

export type ValidateNodeModuleArtifactOptions = Readonly<{
	root?: string
}>

export type NodeModuleNativeResidual = Readonly<{
	name: string
	entryPath: string
}>

const forbiddenRuntimeImport = /^@pluxel\/(?:core|runtime)(?:\/|$)/
const forbiddenDeclaration =
	/\b(?:defineNodeModule|defineWorkerTask|workbench\s*\.\s*(?:entry|extension)|Plugin)\s*\(/
const sourceExtensions = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs', '.cts', '.cjs', '.json']
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

/** Build a self-contained, single-file Node ESM artifact. */
export async function buildNodeModule(options: BuildNodeModuleOptions): Promise<void> {
	const root = resolve(options.root)
	const entryPath = resolve(options.entryPath)
	const outFile = resolve(options.outFile)
	const nativeResiduals = await resolveNodeModuleNativeResiduals(entryPath, root)
	const nativePackages = new Set(nativeResiduals.map((residual) => residual.name))
	await validateNodeModuleSourceGraph(entryPath, nativePackages)
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
			plugins: [PreprocessorDirectives()],
			resolve: {
				conditions: ['node', 'import', 'module', 'default'],
			},
			ssr: { noExternal: true },
			build: {
				ssr: true,
				target: 'node24',
				outDir: stagingDir,
				emptyOutDir: true,
				minify: options.minify ?? false,
				sourcemap: false,
				rollupOptions: {
					input: entryPath,
					external: (id: string) =>
						builtins.has(id) || nativePackages.has(readPackageName(id) ?? ''),
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
		await validateNodeModuleOutput(stagedFile, nativePackages)
		await rename(stagedFile, outFile)
	} finally {
		await rm(stagingDir, { recursive: true, force: true })
	}
}

export async function validateNodeModuleArtifact(
	file: string,
	options: ValidateNodeModuleArtifactOptions = {},
): Promise<void> {
	const nativeResiduals = options.root
		? await resolveNativeResidualPackages(resolve(options.root))
		: new Map<string, string>()
	const nativePackages = new Set(nativeResiduals.keys())
	await validateNodeModuleOutput(resolve(file), nativePackages)
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
	const dependencyRoot = resolveNodeModuleDependencyRoot(entryPath, fallbackRoot)
	const residuals = await resolveNativeResidualPackages(dependencyRoot)
	return [...residuals]
		.map(([name, resolvedEntry]) => Object.freeze({ name, entryPath: resolvedEntry }))
		.toSorted((left, right) => left.name.localeCompare(right.name))
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

async function validateNodeModuleSourceGraph(
	entryPath: string,
	nativePackages: ReadonlySet<string>,
): Promise<void> {
	const queue = [entryPath]
	const visited = new Set<string>()
	while (queue.length > 0) {
		const file = resolve(queue.shift()!)
		if (visited.has(file)) continue
		visited.add(file)
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
			if (packageName && nativePackages.has(packageName)) continue
			const hit = resolveWithOxc(dirname(file), item.specifier, {
				extensions: sourceExtensions,
				tsconfig: 'auto',
			})
			if (packageName && hit?.packageJsonPath && (await hasNativeMetadata(hit.packageJsonPath))) {
				throw new Error(
					`[node-module] native dependency ${packageName} must be declared directly in the package dependencies`,
				)
			}
			if (hit?.path && extname(hit.path) === '.node') {
				throw new Error(
					`[node-module] native dependency ${packageName ?? item.specifier} must be declared directly in the package dependencies`,
				)
			}
			if (hit?.path && !visited.has(hit.path)) queue.push(hit.path)
		}
	}
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

async function validateNodeModuleOutput(
	outFile: string,
	nativePackages: ReadonlySet<string>,
): Promise<void> {
	const output = await readFile(outFile, 'utf8')
	const ast = parseStandaloneWithLang(output, outFile)
	if (!ast) throw new Error(`[node-module] generated artifact is not valid ESM: ${outFile}`)
	for (const { specifier } of collectImportSpecifiers(ast)) {
		if (builtins.has(specifier)) continue
		const packageName = readPackageName(specifier)
		if (packageName && nativePackages.has(packageName)) continue
		throw new Error(
			`[node-module] generated artifact is not self-contained; unresolved import: ${specifier}`,
		)
	}
}

async function resolveNativeResidualPackages(root: string): Promise<Map<string, string>> {
	let manifest: {
		dependencies?: Record<string, unknown>
		optionalDependencies?: Record<string, unknown>
	}
	try {
		manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as typeof manifest
	} catch {
		return new Map()
	}
	const names = new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
	])
	const native = new Map<string, string>()
	for (const name of names) {
		const hit = resolveWithOxc(root, name, {
			extensions: sourceExtensions,
			tsconfig: 'auto',
		})
		if (!hit?.path) continue
		if (extname(hit.path) === '.node') {
			native.set(name, hit.path)
			continue
		}
		const packageJson = hit.packageJsonPath
		if (!packageJson) continue
		if (await hasNativeMetadata(packageJson)) native.set(name, hit.path)
	}
	return native
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
