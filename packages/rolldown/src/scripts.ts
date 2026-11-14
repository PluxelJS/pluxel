import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { rolldown, type Plugin } from 'rolldown'
import type { ScriptArtifact } from '@pluxel/host/agent'
import { ScriptInputs } from './script-inputs'
import { readScriptControlModule } from './script-control-inputs'

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
	const inputs = new ScriptInputs(options.signal)
	const controls = new Map<string, string>()
	const findControl = async (id: string): Promise<string | undefined> => {
		if (controls.has(id)) return controls.get(id)
		const code = await readScriptControlModule(inputs, id)
		if (code !== undefined) {
			controls.set(id, code)
			inputs.requireCheckedFile(resolve(dirname(id), 'index.d.mts'))
		}
		return code
	}
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
					const content = inputs.read(resolve(directory, 'package.json'))
					if (content === null) {
						const parent = dirname(directory)
						return parent === directory ? undefined : packageName(parent)
					}
					return (JSON.parse(content) as { name?: string }).name
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
		async resolveId(source, importer) {
			if (importer && forbidden(source)) {
				if (source.startsWith('@pluxel/')) {
					const resolved = await this.resolve(source, importer, { skipSelf: true })
					if (resolved && (await findControl(resolved.id)) !== undefined) return resolved
				}
				rejectImport(
					`Upload scripts cannot import ${JSON.stringify(source)}. Use type-only SDK imports, injected SDK operations, or a Vite project script for real application objects.`,
				)
			}
			return null
		},
		resolveDynamicImport(_source, importer) {
			rejectImport(
				`Upload scripts do not support dynamic imports (${importer}); use static imports for portable computation dependencies`,
			)
		},
		async load(id) {
			const control = await findControl(id)
			if (control !== undefined) return control
			if (id !== file && isAbsolute(id)) {
				const name = await packageName(dirname(id))
				if (runtimePackages.has(name) || /\.node(?:$|\?)/.test(id))
					rejectImport(
						`Upload scripts cannot bundle runtime module ${JSON.stringify(id)}. Access application objects through the injected SDK or a Vite project script.`,
					)
			}
			if (isAbsolute(id) && /\.(?:[cm]?[jt]sx?|json)$/.test(id)) {
				const content = inputs.read(id)
				if (content !== null) return content
			}
			return null
		},
	}
	let build: Awaited<ReturnType<typeof rolldown>> | undefined
	try {
		build = await rolldown({
			input: file,
			resolve: { symlinks: false },
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
		try {
			await inputs.check(file)
		} catch (cause) {
			if (options.signal?.aborted) throw options.signal.reason
			throw new ScriptCompileError(
				'typecheck_failed',
				cause instanceof Error ? cause.message : String(cause),
				{ cause },
			)
		}
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

/** Native type checking for a Vite project; loading remains owned by its existing ModuleRunner. */
export async function checkProjectScript(
	options: Readonly<{ file: string; signal?: AbortSignal }>,
): Promise<
	Readonly<{
		inputs: ReadonlyMap<string, string>
		digest: string
	}>
> {
	const file = await realpath(resolve(options.file))
	const inputs = new ScriptInputs(options.signal)
	try {
		await inputs.check(file)
		for (const path of inputs.snapshot().keys())
			if (path.endsWith('/index.d.mts'))
				await readScriptControlModule(inputs, path.slice(0, -'.d.mts'.length) + '.mjs')
	} catch (cause) {
		if (options.signal?.aborted) throw options.signal.reason
		throw new ScriptCompileError(
			'typecheck_failed',
			cause instanceof Error ? cause.message : String(cause),
			{ cause },
		)
	}
	const captured = inputs.snapshot()
	const digest = createHash('sha256')
	for (const [path, content] of [...captured].sort(([a], [b]) => a.localeCompare(b))) {
		digest
			.update(path)
			.update('\0')
			.update(createHash('sha256').update(content).digest())
			.update('\0')
	}
	return Object.freeze({ inputs: captured, digest: digest.digest('hex') })
}
