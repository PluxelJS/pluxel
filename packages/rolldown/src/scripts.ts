import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { rolldown, type Plugin } from 'rolldown'
import MagicString from 'magic-string'
import type { BindingPattern, ModuleExportName, Program } from 'oxc-parser'
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

/** Lower standard ESM syntax, without depending on a bundler's interop helpers. */
function scriptFactory(code: string, program: Program, filename: string) {
	const output = new MagicString(code)
	const exports = new Map<string, string>()
	const fresh = (base: string): string => {
		while (code.includes(base)) base += '$'
		return base
	}
	const shared = fresh('__pluxel_script_shared')
	const merge = fresh('__pluxel_script_export_star')
	let usesShared = false
	let exportStar = false
	const name = (node: ModuleExportName): string =>
		node.type === 'Identifier' ? node.name : node.value
	const external = (source: string): void => {
		if (source !== '@pluxel/core/better-result')
			throw new ScriptCompileError('unsupported_import', `Unbound script import ${source}`)
		usesShared = true
	}
	const bindings = (pattern: BindingPattern): string[] => {
		switch (pattern.type) {
			case 'Identifier':
				return [pattern.name]
			case 'AssignmentPattern':
				return bindings(pattern.left)
			case 'ObjectPattern':
				return pattern.properties.flatMap((property) =>
					bindings(property.type === 'RestElement' ? property.argument : property.value),
				)
			case 'ArrayPattern':
				return pattern.elements.flatMap((element) =>
					element ? bindings(element.type === 'RestElement' ? element.argument : element) : [],
				)
		}
	}
	for (const statement of program.body) {
		if (statement.type === 'ImportDeclaration') {
			external(statement.source.value)
			if (statement.attributes.length > 0)
				throw new ScriptCompileError(
					'unsupported_import',
					'Script import attributes are unsupported',
				)
			output.overwrite(
				statement.start,
				statement.end,
				statement.specifiers
					.map((specifier) => {
						const value =
							specifier.type === 'ImportNamespaceSpecifier'
								? shared
								: `${shared}[${JSON.stringify(specifier.type === 'ImportDefaultSpecifier' ? 'default' : name(specifier.imported))}]`
						return `const ${specifier.local.name} = ${value};`
					})
					.join('\n'),
			)
		} else if (statement.type === 'ExportNamedDeclaration') {
			if (statement.source) external(statement.source.value)
			if (statement.attributes.length > 0)
				throw new ScriptCompileError(
					'unsupported_import',
					'Script export attributes are unsupported',
				)
			if (statement.declaration) {
				const declaration = statement.declaration
				output.remove(statement.start, declaration.start)
				if (declaration.type === 'VariableDeclaration') {
					for (const item of declaration.declarations)
						for (const binding of bindings(item.id)) exports.set(binding, binding)
				} else if (
					declaration.type === 'FunctionDeclaration' ||
					declaration.type === 'ClassDeclaration'
				) {
					exports.set(declaration.id.name, declaration.id.name)
				} else {
					throw new ScriptCompileError('compile_failed', 'Unsupported script export declaration')
				}
			} else {
				for (const specifier of statement.specifiers) {
					const local = name(specifier.local)
					if (!statement.source && specifier.local.type !== 'Identifier')
						throw new ScriptCompileError('compile_failed', 'Expected a local script export binding')
					exports.set(
						name(specifier.exported),
						statement.source ? `${shared}[${JSON.stringify(local)}]` : local,
					)
				}
				output.remove(statement.start, statement.end)
			}
		} else if (statement.type === 'ExportDefaultDeclaration') {
			const declaration = statement.declaration
			if (
				(declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') &&
				declaration.id
			) {
				output.remove(statement.start, declaration.start)
				exports.set('default', declaration.id.name)
			} else {
				const binding = fresh('__pluxel_script_default')
				output.overwrite(statement.start, declaration.start, `const ${binding} = `)
				output.appendLeft(statement.end, ';')
				exports.set('default', binding)
			}
		} else if (statement.type === 'ExportAllDeclaration') {
			external(statement.source.value)
			if (statement.attributes.length > 0)
				throw new ScriptCompileError(
					'unsupported_import',
					'Script export attributes are unsupported',
				)
			if (statement.exported) exports.set(name(statement.exported), shared)
			else exportStar = true
			output.remove(statement.start, statement.end)
		}
	}
	const result = `{${[...exports]
		.map(([key, value]) => `get [${JSON.stringify(key)}]() { return ${value}; }`)
		.join(',')}}`
	output.prepend(
		`var __pluxel_script_exports = (function(${usesShared ? shared : ''}${exportStar ? `, ${merge}` : ''}) {\n'use strict';\n`,
	)
	output.append(
		`\nreturn ${exportStar ? `${merge}(${shared}, ${result})` : result};\n})(${usesShared ? '__pluxel_script_better_result' : ''}${
			exportStar
				? `, (shared, exports) => {
	for (const key of Object.keys(shared)) {
		if (key !== 'default' && !Object.hasOwn(exports, key))
			Object.defineProperty(exports, key, { enumerable: true, get: () => shared[key] });
	}
	return exports;
}`
				: ''
		});\n`,
	)
	return {
		code: output.toString(),
		map: output.generateMap({ hires: true, source: filename, includeContent: true }),
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
		specifier === 'better-result' ||
		specifier.startsWith('better-result/') ||
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
		'better-result',
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
			// Format 2 binds this exact public entry to the receiver's native module.
			// It never reads or bundles an author's separate Better Result runtime.
			if (importer && source === '@pluxel/core/better-result') return { id: source, external: true }
			if (importer && forbidden(source)) {
				if (source.startsWith('@pluxel/')) {
					const resolved = await this.resolve(source, importer, { skipSelf: true })
					if (resolved && (await findControl(resolved.id)) !== undefined) return resolved
				}
				rejectImport(
					`Upload scripts cannot import ${JSON.stringify(source)}. Use type-only SDK imports, @pluxel/core/better-result, or a Vite project script for real application objects.`,
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
		renderChunk(code, chunk) {
			const factory = scriptFactory(code, this.parse(code), chunk.fileName)
			// The factory is also valid Script syntax: reject module-only constructs
			// such as import.meta and top-level await before admitting the artifact.
			this.parse(factory.code, { sourceType: 'script' })
			return factory
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
			format: 'es',
			// The factory's exports binding is consumed by the appended return below.
			minify: false,
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
				'Upload scripts must produce one JavaScript factory chunk',
			)
		const chunk = chunks[0]
		if (!chunk.exports.includes(exportName))
			throw new ScriptCompileError(
				'export_not_found',
				`Module ${file} does not export ${exportName}`,
			)
		if (
			chunk.imports.some((specifier) => specifier !== '@pluxel/core/better-result') ||
			chunk.dynamicImports.length > 0
		)
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
			format: 'pluxel-js-factory/2',
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
