import { builtinModules } from 'node:module'
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

const forbiddenRuntimeImport = /^@pluxel\/(?:core|runtime)(?:\/|$)/
const forbiddenDeclaration =
	/\b(?:defineNodeModule|workbench\s*\.\s*(?:entry|extension)|Plugin)\s*\(/
const sourceExtensions = ['.tsx', '.ts', '.jsx', '.js', '.mts', '.mjs', '.cts', '.cjs', '.json']
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

/** Build a self-contained, single-file Node ESM artifact. */
export async function buildNodeModule(options: BuildNodeModuleOptions): Promise<void> {
	const root = resolve(options.root)
	const entryPath = resolve(options.entryPath)
	const outFile = resolve(options.outFile)
	await validateNodeModuleSourceGraph(entryPath)
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

export async function validateNodeModuleArtifact(file: string): Promise<void> {
	await validateNodeModuleOutput(resolve(file))
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

async function validateNodeModuleSourceGraph(entryPath: string): Promise<void> {
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
			const hit = resolveWithOxc(dirname(file), item.specifier, {
				extensions: sourceExtensions,
				tsconfig: 'auto',
			})
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
