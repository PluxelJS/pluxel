import { createHash } from 'node:crypto'
import { builtinModules, createRequire } from 'node:module'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, isAbsolute, resolve } from 'node:path'
import { rolldown, type Plugin } from 'rolldown'
import type { ScriptArtifact } from '@pluxel/host/agent'

export type ScriptCompileOptions = Readonly<{
	/** Ordinary TS/JS module. Compilation never evaluates it or the application factory. */
	file: string
	/** Export selected by the receiver. @defaultValue 'default' */
	exportName?: string
	/** Cancels compiler work; it does not submit or cancel a remote run. */
	signal?: AbortSignal
}>
export class ScriptCompileError extends Error {
	constructor(
		readonly code:
			| 'typecheck_failed'
			| 'unsupported_import'
			| 'compile_failed'
			| 'export_not_found'
			| 'source_too_large',
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = 'ScriptCompileError'
	}
}

/** Typecheck and bundle a fresh-module factory. The receiving Host needs only JavaScript. */
export async function compileScript(options: ScriptCompileOptions): Promise<ScriptArtifact> {
	const file = await realpath(resolve(options.file))
	const exportName = options.exportName ?? 'default'
	if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(exportName))
		throw new TypeError('exportName must be a JavaScript identifier')
	options.signal?.throwIfAborted()
	const forbidden = (specifier: string): boolean =>
		specifier.startsWith('@pluxel/') ||
		specifier.startsWith('node:') ||
		builtinModules.includes(specifier) ||
		/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier) ||
		/\.node(?:$|\?)/.test(specifier)
	let importMessage: string | undefined
	const packageNames = new Map<string, Promise<string | undefined>>()
	const runtimePackages = new Set([
		'@pluxel/core',
		'@pluxel/context',
		'@pluxel/host',
		'@pluxel/host-vite',
		'@pluxel/services',
		'@pluxel/workbench',
		'@pluxel/commands',
	])
	const packageName = (directory: string): Promise<string | undefined> => {
		let pending = packageNames.get(directory)
		if (!pending) {
			pending = (async () => {
				try {
					return (
						JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) as {
							name?: string
						}
					).name
				} catch (error) {
					if (error.code !== 'ENOENT') throw error
					const parent = dirname(directory)
					return parent === directory ? undefined : packageName(parent)
				}
			})()
			packageNames.set(directory, pending)
		}
		return pending
	}
	const rejectImport = (message: string): never => {
		importMessage ??= message
		throw new Error(message)
	}
	const imports: Plugin = {
		name: 'pluxel-script-imports',
		resolveId(source, importer) {
			if (importer && forbidden(source))
				rejectImport(
					`Upload scripts cannot import ${JSON.stringify(source)}. Use type-only SDK imports, injected SDK operations, or a Vite project script for real application objects.`,
				)
			return null
		},
		resolveDynamicImport(_source, importer) {
			rejectImport(
				`Upload scripts do not support dynamic imports (${importer}); use static imports for portable computation dependencies`,
			)
		},
		async load(id) {
			if (id !== file && isAbsolute(id)) {
				const name = await packageName(dirname(id))
				if (runtimePackages.has(name) || /\.node(?:$|\?)/.test(id))
					rejectImport(
						`Upload scripts cannot bundle runtime module ${JSON.stringify(id)}. Access application objects through the injected SDK or a Vite project script.`,
					)
			}
			return null
		},
	}
	let build: Awaited<ReturnType<typeof rolldown>> | undefined
	try {
		build = await rolldown({
			input: file,
			plugins: [imports],
			external: [],
			treeshake: true,
			platform: 'neutral',
		})
		const output = await build.generate({
			format: 'iife',
			name: '__pluxel_script_exports',
			sourcemap: 'hidden',
			sourcemapPathTransform: (source, mapFile) =>
				isAbsolute(source) ? source : resolve(dirname(mapFile), source),
			codeSplitting: false,
			exports: 'named',
		})
		const chunks = output.output.filter((item) => item.type === 'chunk')
		if (
			chunks.length !== 1 ||
			output.output.some((item) => item.type === 'asset' && !item.fileName.endsWith('.map'))
		)
			throw new ScriptCompileError(
				'compile_failed',
				'Upload scripts must produce one self-contained JavaScript chunk',
			)
		const chunk = chunks[0]
		if (!chunk.exports.includes(exportName))
			throw new ScriptCompileError(
				'export_not_found',
				`Module ${file} does not export ${exportName}`,
			)
		if (chunk.imports.length > 0 || chunk.dynamicImports.length > 0)
			throw new ScriptCompileError(
				'unsupported_import',
				'The script contains unresolved runtime imports',
			)
		const code = `${chunk.code}\nreturn __pluxel_script_exports;\n`
		const sourceMap = chunk.map?.toString()
		if (
			Buffer.byteLength(code) > 1024 * 1024 ||
			(sourceMap && Buffer.byteLength(sourceMap) > 1024 * 1024)
		)
			throw new ScriptCompileError(
				'source_too_large',
				'Compiled script or source map exceeds 1 MiB',
			)
		await checkScript(file, options.signal)
		return {
			kind: 'artifact',
			format: 'pluxel-js-factory/1',
			code,
			sourceHash: createHash('sha256').update(code).digest('hex'),
			exportName,
			...(sourceMap === undefined ? {} : { sourceMap }),
		}
	} catch (cause) {
		if (importMessage) throw new ScriptCompileError('unsupported_import', importMessage, { cause })
		if (cause instanceof ScriptCompileError) throw cause
		throw new ScriptCompileError(
			'compile_failed',
			cause instanceof Error ? cause.message : 'Script compilation failed',
			{ cause },
		)
	} finally {
		await build?.close()
	}
}

async function checkScript(file: string, signal?: AbortSignal): Promise<void> {
	let directory = dirname(file)
	let configPath: string | undefined
	while (true) {
		try {
			await access(resolve(directory, 'tsconfig.json'))
			configPath = resolve(directory, 'tsconfig.json')
			break
		} catch (error) {
			if (error.code !== 'ENOENT') throw error
		}
		const parent = dirname(directory)
		if (parent === directory) break
		directory = parent
	}
	// Keeping the transient config beside its author preserves native inferred @types lookup.
	const temporary = await mkdtemp(
		resolve(configPath ? dirname(configPath) : dirname(file), '.pluxel-script-types-'),
	)
	try {
		const config = resolve(temporary, 'tsconfig.json')
		await writeFile(
			config,
			JSON.stringify({
				...(configPath ? { extends: configPath } : {}),
				files: [file],
				include: [],
				exclude: [],
				compilerOptions: {
					...(!configPath
						? {
								target: 'ES2023',
								module: 'ESNext',
								moduleResolution: 'Bundler',
								strict: true,
								skipLibCheck: true,
							}
						: {}),
					noEmit: true,
					incremental: false,
					composite: false,
					declaration: false,
					emitDeclarationOnly: false,
					allowJs: true,
					checkJs: true,
				},
			}),
		)
		const compiler = resolve(
			dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
			'bin/tsc',
		)
		try {
			await promisify(execFile)(
				process.execPath,
				[compiler, '--project', config, '--pretty', 'false'],
				{ signal, maxBuffer: 4 * 1024 * 1024 },
			)
		} catch (cause) {
			if (signal?.aborted) throw signal.reason
			throw new ScriptCompileError(
				'typecheck_failed',
				String(cause.stdout || cause.stderr || cause.message),
				{ cause },
			)
		}
	} finally {
		await rm(temporary, { recursive: true, force: true })
	}
}
