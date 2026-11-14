import { execFile } from 'node:child_process'
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { version } from 'typescript'
import { API, DiagnosticCategory, SymbolFlags, type Project } from 'typescript/unstable/sync'
import {
	CommentDirectiveType,
	createScanner,
	ScriptKind,
	SyntaxKind,
	type ClassDeclaration,
	type Node,
	type SourceFile,
	type StringLiteral,
	type VariableDeclaration,
} from 'typescript/unstable/ast'
import { parseSync } from 'oxc-parser'
import { pluginDefinitionIndexKey, type PluginDefinitionAddress } from '@pluxel/core'
import {
	inspectPluginSource,
	type InspectedSemanticOwner,
} from '../rolldown/plugins/pluginSemanticsPlugin.ts'
import {
	extractConfigDeclarationFacts,
	type ConfigDeclarationFact,
} from '../rolldown/plugins/configSourcePlugin.ts'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils.ts'
import {
	controlSha256,
	encodeControlData,
	isControlExportName,
	renderPluginDescriptors,
	verifyPluginControlMaterial,
	type PluginControlManifest,
} from './manifest.ts'

export type PluginControlSource = Readonly<{
	moduleId: string
	className: string
	definition: PluginDefinitionAddress
}>

export type PluginControlGeneration = Readonly<{
	format: 1
	snapshot: string
	manifest: PluginControlManifest
	files: Readonly<Record<string, string>>
	/** Original physical files read by this compilation, including type-only dependencies. */
	inputs: Readonly<Record<string, string>>
	/** Relevant frozen inputs per canonical definition, for selective type-only HMR. */
	definitionInputs: Readonly<Record<string, readonly string[]>>
}>

const exec = promisify(execFile)
const posix = (path: string): string => path.split(sep).join('/')
const moduleFile = (id: string): string => resolve(id.split(/[?#]/, 1)[0]!)
const fail = (message: string): never => {
	throw new Error(`[pluxel:control] ${message}`)
}

type ConfigSource = {
	path: readonly string[]
	source: string
	className: string
	expression: string
	dependencies: readonly { source: string; name: string; declaration: string }[]
}
type ConfigShape = { input: string; output: string; sources: ConfigSource[] }

/**
 * Analyze without evaluation, then run the installed native declaration emitter over a frozen
 * physical copy of that exact TypeScript program. No project source or package entry is loaded.
 */
export async function generatePluginControl(options: {
	root: string
	definitions: readonly PluginControlSource[]
	/** Compiler project owned by the build root; false selects the explicit no-project defaults. */
	tsconfig?: string | false
	/** Exact preprocessed source seen by the semantic pass; keyed by physical module id. */
	sources?: ReadonlyMap<string, string>
	/** Standalone application materials carry declarations; package SDKs may anchor installed public types. */
	typeImports?: 'closure' | 'package'
	signal?: AbortSignal
}): Promise<PluginControlGeneration> {
	const root = realpathSync(resolve(options.root))
	const definitions = [...options.definitions].sort((a, b) =>
		pluginDefinitionIndexKey(a.definition).localeCompare(pluginDefinitionIndexKey(b.definition)),
	)
	const temporary = await mkdtemp(resolve(tmpdir(), 'pluxel-control-'))
	const captured = new Map<string, string>(),
		originals = new Map<string, string>(),
		realpaths = new Map<string, string>()
	const overrides = new Map(
		[...(options.sources ?? [])].map(([path, code]) => [moduleFile(path), code]),
	)
	const read = (path: string): string | null => {
		const key = resolve(path)
		if (captured.has(key)) return captured.get(key)!
		let content: string
		try {
			content = readFileSync(key, 'utf8')
		} catch (error) {
			if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR')
				return null
			throw error
		}
		if (captured.size >= 16384) fail('TypeScript input file budget exceeded (16384 files)')
		originals.set(key, content)
		captured.set(key, overrides.get(key) ?? content)
		return captured.get(key)!
	}
	const api = new API({
		cwd: root,
		fs: {
			readFile: read,
			realpath(path) {
				try {
					const actual = realpathSync(path)
					realpaths.set(resolve(path), actual)
					return actual
				} catch {
					return path
				}
			},
		},
	})
	let declarationApi: API | undefined
	let declarationSnapshot: ReturnType<API['updateSnapshot']> | undefined
	try {
		const projectConfig =
			options.tsconfig === false
				? undefined
				: options.tsconfig === undefined
					? findConfig(root)
					: resolve(root, options.tsconfig)
		// Type directives resolve from the project directory. Keep this virtual config
		// there while all physical emitter inputs stay outside the watched workspace.
		const config = resolve(
			projectConfig ? dirname(projectConfig) : root,
			`.tsconfig-${basename(temporary)}.json`,
		)
		const authorConfig = projectConfig ? api.parseConfigFile(projectConfig) : undefined
		const ambientRoots = authorConfig?.fileNames.filter((path) => /\.d\.[cm]?ts$/.test(path)) ?? []
		const owners = new Map<string, InspectedSemanticOwner>()
		const configs = new Map<string, ConfigDeclarationFact>()
		const helpers = new Map<string, string>()
		for (const source of definitions) {
			const inspected = await inspectPluginSource({
				moduleId: moduleFile(source.moduleId),
				root,
				readSource: async (path) => read(path) ?? fail(`Source disappeared: ${path}`),
			})
			for (const owner of inspected.owners)
				owners.set(`${owner.moduleId}#${owner.className}`, owner)
			for (const item of inspected.files) {
				if (!/\.[cm]?[jt]sx?$/.test(item.id)) continue
				const ast =
					parseStandaloneWithLang(item.code, item.id) ??
					fail(`Cannot parse config source ${item.id}`)
				for (const fact of extractConfigDeclarationFacts(ast, item.code, item.id, fail)
					.declarations) {
					const key = `${item.id}#${fact.className}`
					configs.set(key, fact)
					helpers.set(key, `__pluxelControlSchema_${fact.className}`)
				}
			}
		}
		for (const [key, fact] of configs) {
			const owner = owners.get(key)
			if (!owner) continue
			const code =
				captured.get(owner.moduleId) ??
				read(owner.moduleId) ??
				fail(`Missing config source ${owner.moduleId}`)
			captured.set(
				owner.moduleId,
				`${code}\nexport const ${helpers.get(key)!} = ${fact.schemaExpression};\ntype __pluxelControlRequireObject_${owner.className}<T extends object> = T;\nexport type __pluxelControlOutput_${owner.className} = __pluxelControlRequireObject_${owner.className}<NonNullable<(typeof ${helpers.get(key)!})['~standard']['types']>['output']>;\n`,
			)
		}
		const instanceHelpers = new Set<string>()
		for (const source of definitions) {
			const path = moduleFile(source.moduleId)
			const key = `${path}#${source.className}`
			if (instanceHelpers.has(key)) continue
			instanceHelpers.add(key)
			const code = captured.get(path) ?? read(path) ?? fail(`Missing Plugin source ${path}`)
			captured.set(
				path,
				`${code}\nexport type __pluxelControlInstance_${source.className} = ${source.className};\n`,
			)
		}
		const nodeTypes = dirname(createRequire(import.meta.url).resolve('@types/node/package.json'))
		const configuredTypes = authorConfig?.options.types as readonly string[] | undefined
		const configuredTypeRoots = authorConfig?.options.typeRoots as readonly string[] | undefined
		captured.set(
			config,
			JSON.stringify({
				...(projectConfig ? { extends: projectConfig } : {}),
				files: [...definitions.map((entry) => moduleFile(entry.moduleId)), ...ambientRoots],
				include: [],
				compilerOptions: {
					...(projectConfig
						? {}
						: { target: 'ES2023', lib: ['ES2024', 'ESNext.Disposable', 'DOM', 'DOM.Iterable'] }),
					types: configuredTypes ?? [nodeTypes],
					// Leave native package-export resolution intact for directives such as vite/client.
					typeRoots: configuredTypeRoots,
					module: 'ESNext',
					moduleResolution: 'bundler',
					noEmit: true,
					experimentalDecorators: true,
					customConditions: (authorConfig?.options.customConditions as string[]) ?? ['@pluxel/hmr'],
					skipLibCheck: true,
					incremental: false,
					composite: false,
				},
			}),
		)
		options.signal?.throwIfAborted()
		const snapshot = api.updateSnapshot({ openProjects: [config] })
		try {
			const project =
				snapshot.getProject(config) ?? fail('Native TypeScript did not open the control program')
			const configurationErrors = project.program
				.getProgramDiagnostics()
				.filter((diagnostic) => diagnostic.category === DiagnosticCategory.Error)
			if (configurationErrors.length > 0)
				fail(
					`Native TypeScript configuration failed:\n${configurationErrors.map((diagnostic) => `TS${diagnostic.code}: ${diagnostic.text}`).join('\n')}`,
				)
			const names = project.program.getSourceFileNames()
			const jsonFiles = new Set(
				names.filter((name) => project.program.getSourceFile(name)!.scriptKind === ScriptKind.JSON),
			)
			// Native standard-library and automatic type discovery may use its internal cache.
			// Fetch every program source explicitly before constructing the emitter filesystem.
			for (const name of names) {
				const file = project.program.getSourceFile(name)
				if (!file) fail(`Native program omitted source contents: ${name}`)
				captured.set(name, file!.text)
				if (!originals.has(name)) originals.set(name, readFileSync(name, 'utf8'))
			}
			const identities = new Map<string, string>()
			const identify = (path: string): string => {
				const physical = resolve(path)
				let known = identities.get(physical)
				if (known) return known
				let directory = dirname(physical)
				while (true) {
					const manifestPath = resolve(directory, 'package.json')
					const json = read(manifestPath)
					if (json !== null) {
						let manifest: { name?: string; version?: string }
						try {
							manifest = JSON.parse(json)
						} catch {
							fail(`Invalid package metadata: ${manifestPath}`)
						}
						if (manifest!.name) {
							known = `${manifest!.name}@${manifest!.version ?? 'workspace'}/${posix(relative(directory, physical))}`
							break
						}
					}
					const parent = dirname(directory)
					if (parent === directory) break
					directory = parent
				}
				known ??= `source/${posix(relative(root, physical))}`
				identities.set(physical, known)
				return known
			}
			const declarationFiles = await emitDeclarations({
				temporary,
				root,
				projectConfig,
				config,
				names,
				jsonFiles,
				captured,
				realpaths,
				typeRoots: project.compilerOptions.typeRoots,
				customConditions: project.compilerOptions.customConditions,
				signal: options.signal,
			})
			// Native emitted references exclude implementation imports that must not couple
			// independent Plugins. Resolve them against the same frozen program inputs.
			const declarationConfig = resolve(
				dirname(config),
				`.tsconfig-types-${basename(temporary)}.json`,
			)
			captured.set(
				declarationConfig,
				JSON.stringify({ ...JSON.parse(captured.get(config)!), files: names }),
			)
			declarationApi = new API({
				cwd: root,
				fs: {
					readFile(path) {
						const key = resolve(path)
						return declarationFiles.get(key) ?? captured.get(key) ?? null
					},
					realpath(path) {
						return realpaths.get(resolve(path)) ?? path
					},
				},
			})
			declarationSnapshot = declarationApi.updateSnapshot({ openProjects: [declarationConfig] })
			const declarationProject =
				declarationSnapshot.getProject(declarationConfig) ??
				fail('Native TypeScript did not open the emitted declaration program')
			const declarationGraph = createDeclarationGraph(
				declarationProject,
				declarationFiles,
				ambientRoots,
			)
			const resolveDeclaration = (specifier: string, importer: string): string | undefined => {
				if (!specifier.startsWith('.') && !isAbsolute(specifier)) return undefined
				const candidate = resolve(dirname(importer), specifier)
				const stem = candidate.replace(/\.(?:js|mjs|cjs)$/, '')
				for (const file of [
					candidate,
					`${stem}.ts`,
					`${stem}.mts`,
					`${stem}.cts`,
					`${stem}.d.ts`,
					`${stem}.d.mts`,
					`${stem}.d.cts`,
					`${candidate}.ts`,
					`${candidate}.mts`,
					`${candidate}.d.ts`,
					resolve(candidate, 'index.ts'),
					resolve(candidate, 'index.d.ts'),
				])
					if (declarationFiles.has(file)) return file
				return fail(
					`Declaration dependency cannot be relocated: ${identify(importer)} -> ${specifier}`,
				)
			}
			const selectedDeclarations = new Set<string>()
			const visitDeclaration = (path: string) => {
				if (selectedDeclarations.has(path)) return
				selectedDeclarations.add(path)
				const text = declarationFiles.get(path) ?? fail(`Missing declaration for ${identify(path)}`)
				if (jsonFiles.has(path)) return
				for (const reference of declarationReferences(text, path)) {
					const target = resolveDeclaration(reference.specifier, path)
					if (target) visitDeclaration(target)
				}
			}
			for (const source of definitions) visitDeclaration(moduleFile(source.moduleId))
			for (const path of ambientRoots) visitDeclaration(path)
			const materials: Record<string, string> = {}
			const declarationPaths = new Map<string, string>()
			for (const original of selectedDeclarations)
				declarationPaths.set(
					original,
					`types/${controlSha256(identify(original)).slice(0, 16)}/${basenameDeclaration(original)}`,
				)
			const locate = (specifier: string, importer: string): string | undefined => {
				if (!specifier.startsWith('.') && !isAbsolute(specifier)) return undefined
				const target = resolveDeclaration(specifier, importer)
				if (target && !declarationPaths.has(target))
					fail(`Type reference lies outside the emitted declaration closure: ${identify(target)}`)
				return target
			}
			const rewriteImports = (
				text: string,
				importer: string,
				output: string,
				typeExpression = false,
			): string => {
				const prefix = typeExpression ? 'type __Control = ' : ''
				let rewritten = text
				for (const reference of declarationReferences(prefix + text, importer).sort(
					(a, b) => b.start - a.start,
				)) {
					const target = locate(reference.specifier, importer)
					if (!target) continue
					let path = posix(relative(dirname(output), declarationPaths.get(target)!))
					if (reference.kind === 'module')
						path = path.replace(/\.d\.(ts|mts|cts)$/, (_, extension: string) =>
							extension === 'mts' ? '.mjs' : extension === 'cts' ? '.cjs' : '.js',
						)
					if (!path.startsWith('.')) path = `./${path}`
					rewritten =
						rewritten.slice(0, reference.start - prefix.length) +
						JSON.stringify(path) +
						rewritten.slice(reference.end - prefix.length)
				}
				return rewritten
			}
			for (const original of selectedDeclarations) {
				const text = declarationFiles.get(original)!
				const destination = declarationPaths.get(original)!
				materials[destination] = jsonFiles.has(original)
					? text
					: rewriteImports(text, original, destination)
			}
			const declarationHashes = new Map<string, string>()
			const declarationContract = (paths: ReadonlySet<string>) =>
				[...paths]
					.map((path) => {
						let sha256 = declarationHashes.get(path)
						if (!sha256) {
							const materialPath = declarationPaths.get(path)
							sha256 = controlSha256(
								materialPath && !jsonFiles.has(path)
									? encodeControlData(normalizeDeclaration(materials[materialPath]!, materialPath))
									: (declarationFiles.get(path) ?? fail(`Missing declaration input ${path}`)),
							)
							declarationHashes.set(path, sha256)
						}
						return { source: identify(path), sha256 }
					})
					.sort((a, b) => a.source.localeCompare(b.source))
			const pathsByIdentity = new Map(
				[...declarationFiles.keys()].map((path) => [identify(path), path]),
			)
			const definitionInputs: Record<string, readonly string[]> = {}
			const sharedMetadata = [...originals.keys()].filter(
				(path) =>
					!jsonFiles.has(path) &&
					!/\.[cm]?[jt]sx?$/.test(path) &&
					!path.startsWith(temporary + sep),
			)
			const declarations: string[] = [
				...ambientRoots.map(
					(path) =>
						`/// <reference path=${JSON.stringify(`./${declarationPaths.get(path)!}`)} />\n`,
				),
				"import type { PluginDescriptor } from '@pluxel/host/agent'\n",
				"type __ControlInput<S extends { readonly '~standard': { readonly types?: { readonly input: unknown; readonly output: unknown } } }> = NonNullable<S['~standard']['types']>['input']\ntype __ControlOutput<S extends { readonly '~standard': { readonly types?: { readonly input: unknown; readonly output: unknown } } }> = NonNullable<S['~standard']['types']>['output']\n",
			]
			const exported = new Set<string>(['PluginDescriptor', '__ControlInput', '__ControlOutput'])
			const manifestDefinitions: PluginControlManifest['definitions'][number][] = []
			for (const source of definitions) {
				options.signal?.throwIfAborted()
				const file =
					project.program.getSourceFile(moduleFile(source.moduleId)) ??
					fail(`Missing TypeScript source for ${source.moduleId}`)
				const klass =
					findClass(file, source.className) ??
					fail(`Missing Plugin class ${source.className} in ${identify(file.fileName)}`)
				const classSymbol =
					project.checker.getSymbolAtLocation(klass.name!) ??
					fail(`Cannot resolve class ${source.className}`)
				const instance = project.checker.getDeclaredTypeOfSymbol(classSymbol)
				const keys = project.checker
					.getPropertiesOfType(instance)
					.map((symbol) => symbol.name)
					.sort()
				const shape = configTree(
					project,
					owners,
					configs,
					helpers,
					`${file.fileName}#${source.className}`,
					[],
					identify,
				)
				let exportName = isControlExportName(source.definition.exportName)
					? source.definition.exportName
					: `Plugin_${controlSha256(pluginDefinitionIndexKey(source.definition)).slice(0, 16)}`
				const exportedNames = (name: string): readonly string[] => [
					name,
					`${name}ConfigInput`,
					`${name}ConfigOutput`,
					`${name}ConfigDeclaration`,
					`${name}Instance`,
					`__${name}Class`,
				]
				if (exportedNames(exportName).some((name) => exported.has(name)))
					exportName = `Plugin_${controlSha256(pluginDefinitionIndexKey(source.definition)).slice(0, 32)}`
				if (exportedNames(exportName).some((name) => exported.has(name)))
					fail(`Generated export name collision for ${pluginDefinitionIndexKey(source.definition)}`)
				for (const name of exportedNames(exportName)) exported.add(name)
				const canonicalClass =
					options.typeImports !== 'package' || source.definition.entry.kind === 'source-entry'
						? undefined
						: `${source.definition.entry.packageName}${source.definition.entry.kind === 'package-subpath' ? source.definition.entry.subpath.slice(1) : ''}`
				const localDeclaration =
					declarationPaths.get(file.fileName) ??
					fail(`No native declaration emitted for ${identify(file.fileName)}`)
				const classImport =
					canonicalClass ??
					`./${localDeclaration.replace(/\.d\.(ts|mts|cts)$/, (_, extension: string) => (extension === 'mts' ? '.mjs' : extension === 'cts' ? '.cjs' : '.js'))}`
				declarations.push(
					`import type { ${canonicalClass ? JSON.stringify(source.definition.exportName) : `__pluxelControlInstance_${source.className}`} as __${exportName}Class } from ${JSON.stringify(classImport)}\n`,
				)
				const input = shape
					? rewriteImports(shape.input, file.fileName, 'index.d.mts', true)
					: 'never'
				const output = shape
					? rewriteImports(shape.output, file.fileName, 'index.d.mts', true)
					: 'never'
				if (shape) {
					declarations.push(
						`/** Original configuration expressions. These are source descriptions, never executable exports.\n${shape.sources.map((item) => ` * ${item.source} ${JSON.stringify(item.path)}\n * ${escapeComment(item.expression)}\n${item.dependencies.map((dependency) => ` * ${dependency.source} #${dependency.name}\n * ${escapeComment(dependency.declaration)}\n`).join('')}`).join('')} */\n`,
					)
					declarations.push(
						`export type ${exportName}ConfigDeclaration = ${readonlyLiteral(shape.sources)}\n`,
					)
				} else declarations.push(`export type ${exportName}ConfigDeclaration = never\n`)
				declarations.push(
					`export type ${exportName}ConfigInput = ${input}\nexport type ${exportName}ConfigOutput = ${output}\nexport type ${exportName}Instance = __${exportName}Class\nexport declare const ${exportName}: PluginDescriptor<${exportName}ConfigInput, ${exportName}ConfigOutput, ${exportName}Instance>\n`,
				)
				const environment = {
					format: 1,
					compiler: `typescript@${version}`,
					strictNullChecks: project.compilerOptions.strictNullChecks ?? false,
				}
				const schemaDeclarations = shape
					? shape.sources.map((item) => {
							const owner = [...owners.values()].find(
								(candidate) =>
									identify(candidate.moduleId) === item.source &&
									candidate.className === item.className,
							)!
							const helper = helpers.get(`${owner.moduleId}#${owner.className}`)!
							return {
								source: item.source,
								type: normalizeSchemaDeclaration(declarationFiles.get(owner.moduleId)!, helper),
							}
						})
					: []
				const instanceInputs = declarationGraph.closure([file.fileName])
				const configTypes = shape
					? shape.sources.map((item) => {
							const owner =
								pathsByIdentity.get(item.source) ??
								fail(`Missing config declaration input ${item.source}`)
							return schemaTypeDependencies(
								declarationProject,
								owner,
								helpers.get(`${owner}#${item.className}`)!,
							)
						})
					: []
				const configInputs = declarationGraph.closure(
					configTypes.flatMap((types) => [...types.files]),
				)
				const configSources =
					shape?.sources
						.flatMap((item) => [
							item.source,
							...item.dependencies.map((dependency) => dependency.source),
						])
						.map(
							(identity) =>
								pathsByIdentity.get(identity) ?? fail(`Missing config source input ${identity}`),
						) ?? []
				definitionInputs[pluginDefinitionIndexKey(source.definition)] = Object.freeze(
					[
						...new Set([...instanceInputs, ...configInputs, ...configSources, ...sharedMetadata]),
					].sort(),
				)
				const contracts = Object.freeze({
					config: shape
						? `sha256:${controlSha256(encodeControlData({ environment, input: normalizeType(input), output: normalizeType(output), schemas: shape.sources.map((item) => ({ path: item.path, expression: normalizeExpression(item.expression), dependencies: item.dependencies.map((dependency) => ({ source: dependency.source, name: dependency.name, declaration: normalizeSource(dependency.declaration, dependency.source) })) })), schemaDeclarations, localTypes: configTypes.map((types) => types.local), dependencies: declarationContract(configInputs) }))}`
						: null,
					instance: `sha256:${controlSha256(encodeControlData({ environment, keys, declarations: declarationContract(instanceInputs) }))}`,
				})
				manifestDefinitions.push(
					Object.freeze({
						definition: source.definition,
						exportName,
						contracts,
						source: identify(file.fileName),
					}),
				)
			}
			materials['index.d.mts'] = declarations.join('\n')
			materials['index.mjs'] = renderPluginDescriptors(
				manifestDefinitions.map((entry) => ({
					exportName: entry.exportName,
					descriptor: { format: 1, definition: entry.definition, contracts: entry.contracts },
				})),
			)
			const unsigned = {
				format: 1 as const,
				compiler: `typescript@${version}`,
				definitions: manifestDefinitions,
				files: Object.entries(materials)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([path, text]) => ({
						path,
						size: Buffer.byteLength(text),
						sha256: controlSha256(text),
					})),
			}
			const manifest: PluginControlManifest = Object.freeze({
				...unsigned,
				snapshot: `sha256:${controlSha256(encodeControlData(unsigned))}`,
			})
			materials['manifest.json'] = `${encodeControlData(manifest)}\n`
			await verifyPluginControlMaterial(manifest, materials)
			const inputs: Record<string, string> = {}
			for (const [path, content] of originals) {
				if (path.startsWith(temporary + sep)) continue
				if ((await readFile(path, 'utf8').catch((): undefined => undefined)) !== content)
					fail(`source_changed: ${identify(path)}`)
				inputs[path] = controlSha256(content)
			}
			return Object.freeze({
				format: 1,
				snapshot: manifest.snapshot,
				manifest,
				files: Object.freeze(materials),
				inputs: Object.freeze(inputs),
				definitionInputs: Object.freeze(definitionInputs),
			})
		} finally {
			snapshot.dispose()
		}
	} finally {
		declarationSnapshot?.dispose()
		declarationApi?.close()
		api.close()
		await rm(temporary, { recursive: true, force: true })
	}
}

function findClass(file: SourceFile, name: string): ClassDeclaration | undefined {
	return file.statements.find(
		(node): node is ClassDeclaration =>
			node.kind === SyntaxKind.ClassDeclaration && (node as ClassDeclaration).name?.text === name,
	)
}

function createDeclarationGraph(
	project: Project,
	declarations: ReadonlyMap<string, string>,
	ambientRoots: readonly string[],
) {
	const files = new Map(
		project.program
			.getSourceFileNames()
			.map((path) => [path, project.program.getSourceFile(path)!]),
	)
	const shared = new Set(ambientRoots)
	for (const [path, file] of files) {
		// JSON has no externalModuleIndicator, but contributes no ambient declarations.
		if (file.scriptKind === ScriptKind.JSON) continue
		if (
			!file.externalModuleIndicator ||
			project.program.isSourceFileDefaultLibrary(file) ||
			file.typeReferenceDirectives.length > 0 ||
			file.libReferenceDirectives.length > 0 ||
			file.moduleAugmentations.some((node) => node.getText(file) === 'global')
		)
			shared.add(path)
	}
	const edges = new Map<string, ReadonlySet<string>>()
	const directives = new Map<string, ReadonlySet<number>>()
	const dependencies = (path: string): ReadonlySet<string> => {
		const cached = edges.get(path)
		if (cached) return cached
		const file = files.get(path) ?? fail(`Native declaration graph omitted ${path}`)
		if (!declarations.has(path))
			fail(`Native declaration graph introduced an unfrozen input: ${path}`)
		const targets = new Set<string>()
		for (const imported of file.imports) {
			let symbol = project.checker.getSymbolAtLocation(imported)
			if (symbol && symbol.flags & SymbolFlags.Alias)
				symbol = project.checker.getAliasedSymbol(symbol)
			const resolved =
				symbol?.declarations
					?.map((handle) => handle.resolve()?.getSourceFile().fileName)
					.filter((target): target is string => target !== undefined) ?? []
			if (resolved.length === 0) {
				if (imported.kind === SyntaxKind.StringLiteral) {
					const specifier = (imported as StringLiteral).text
					if (!specifier.startsWith('.') && !isAbsolute(specifier)) {
						let lines = directives.get(path)
						if (!lines) {
							lines = commentDirectiveLines(file)
							directives.set(path, lines)
						}
						if (isImportSuppressed(file, imported, lines)) continue
					}
				}
				fail(`Cannot resolve emitted declaration import ${imported.getText(file)} in ${path}`)
			}
			for (const target of resolved) targets.add(target)
		}
		for (const reference of file.referencedFiles)
			targets.add(resolve(dirname(path), reference.fileName))
		edges.set(path, targets)
		return targets
	}
	return {
		closure(roots: readonly string[]): ReadonlySet<string> {
			const selected = new Set<string>()
			const pending = [...shared, ...roots]
			while (pending.length > 0) {
				const path = pending.pop()!
				if (selected.has(path)) continue
				selected.add(path)
				for (const dependency of dependencies(path)) pending.push(dependency)
			}
			return selected
		},
	}
}

/** Use this compiler's scanner on actual comments, never strings that resemble directives. */
function commentDirectiveLines(file: SourceFile): ReadonlySet<number> {
	const lines = new Set<number>()
	for (const comment of parseSync(file.fileName, file.text, { sourceType: 'module' }).comments) {
		const scanner = createScanner(
			false,
			file.languageVariant,
			file.text,
			comment.start,
			comment.end - comment.start,
		)
		while (scanner.scan() !== SyntaxKind.EndOfFile) {}
		for (const directive of scanner.getCommentDirectives() ?? [])
			if (
				directive.type === CommentDirectiveType.Ignore ||
				directive.type === CommentDirectiveType.ExpectError
			)
				lines.add(file.getLineAndCharacterOfPosition(directive.range.end).line)
	}
	return lines
}

function isImportSuppressed(file: SourceFile, imported: Node, directives: ReadonlySet<number>) {
	const starts = file.getLineStarts()
	for (
		let line = file.getLineAndCharacterOfPosition(imported.getStart(file)).line - 1;
		line >= 0;
		line--
	) {
		if (directives.has(line)) return true
		const text = file.text.slice(starts[line], starts[line + 1]).trim()
		if (text.length > 0 && !text.startsWith('//')) return false
	}
	return false
}

/** Schema types can reference local aliases without making unrelated class methods config inputs. */
function schemaTypeDependencies(
	project: Project,
	path: string,
	helper: string,
): { files: ReadonlySet<string>; local: readonly unknown[] } {
	const file =
		project.program.getSourceFile(path) ?? fail(`Missing native schema declaration ${path}`)
	let schema: VariableDeclaration | undefined
	const find = (node: Node): void => {
		if (
			node.kind === SyntaxKind.VariableDeclaration &&
			(node as VariableDeclaration).name.getText(file) === helper
		)
			schema = node as VariableDeclaration
		else node.forEachChild(find)
	}
	find(file)
	const type = schema?.type ?? fail(`Native schema witness omitted its type: ${helper}`)
	const files = new Set<string>(),
		local = new Map<string, unknown>()
	const pending = [type as Node]
	const seen = new Set<string>()
	while (pending.length > 0) {
		const visit = (node: Node): void => {
			if (node.kind === SyntaxKind.Identifier) {
				let symbol = project.checker.getSymbolAtLocation(node)
				if (symbol && symbol.flags & SymbolFlags.Alias)
					symbol = project.checker.getAliasedSymbol(symbol)
				for (const handle of symbol?.declarations ?? []) {
					const declaration = handle.resolve()
					if (!declaration) continue
					const owner = declaration.getSourceFile()
					if (owner.fileName !== path || declaration.kind === SyntaxKind.SourceFile) {
						files.add(owner.fileName)
						continue
					}
					if (declaration.pos >= type.pos && declaration.end <= type.end) continue
					const key = `${declaration.pos}:${declaration.end}`
					if (seen.has(key)) continue
					seen.add(key)
					if (
						![
							SyntaxKind.TypeAliasDeclaration,
							SyntaxKind.InterfaceDeclaration,
							SyntaxKind.ClassDeclaration,
							SyntaxKind.EnumDeclaration,
							SyntaxKind.VariableDeclaration,
							SyntaxKind.ModuleDeclaration,
						].includes(declaration.kind)
					)
						continue
					const code =
						declaration.kind === SyntaxKind.VariableDeclaration
							? `declare const ${declaration.getText(owner)};`
							: declaration.getText(owner)
					local.set(key, normalizeDeclaration(code, path))
					pending.push(declaration)
				}
			}
			node.forEachChild(visit)
		}
		visit(pending.pop()!)
	}
	return { files, local: [...local.values()] }
}

function configTree(
	project: Project,
	owners: ReadonlyMap<string, InspectedSemanticOwner>,
	configs: ReadonlyMap<string, ConfigDeclarationFact>,
	helpers: ReadonlyMap<string, string>,
	key: string,
	path: readonly string[],
	identify: (path: string) => string,
	parents = new Set<string>(),
): ConfigShape | undefined {
	if (parents.has(key)) fail(`Recursive Part ownership: ${key}`)
	const owner = owners.get(key) ?? fail(`Missing config owner facts: ${key}`)
	const fact = configs.get(key)
	const sources: ConfigSource[] = []
	let own: { input: string; output: string } | undefined
	if (fact) {
		const file =
			project.program.getSourceFile(owner.moduleId) ??
			fail(`Part/config source absent from TypeScript program: ${owner.moduleId}`)
		const node =
			findExpression(file, fact.schema.start, fact.schema.end) ??
			fail(`Cannot locate ${owner.className} schema expression`)
		const reference = `typeof import(${JSON.stringify(owner.moduleId)}).${helpers.get(key) ?? fail(`Missing schema declaration helper ${key}`)}`
		own = { input: `__ControlInput<${reference}>`, output: `__ControlOutput<${reference}>` }
		sources.push({
			path,
			source: identify(owner.moduleId),
			className: owner.className,
			expression: fact.schemaExpression,
			dependencies: schemaDependencies(project, node, identify),
		})
	}
	const children = owner.parts.flatMap((part) => {
		if (!part.target) fail(`Unresolved Part ${owner.className}.${part.fieldName}`)
		const child = configTree(
			project,
			owners,
			configs,
			helpers,
			`${part.target!.moduleId}#${part.target!.className}`,
			[...path, part.fieldName],
			identify,
			new Set([...parents, key]),
		)
		if (!child) return []
		sources.push(...child.sources)
		return [{ key: part.fieldName, shape: child }]
	})
	if (!own && children.length === 0) return undefined
	const nested = (side: 'input' | 'output') =>
		`{ ${children.map((child) => `${JSON.stringify(child.key)}${side === 'input' ? '?' : ''}: ${child.shape[side]}`).join('; ')} }`
	return {
		input: own
			? children.length > 0
				? `(${own.input}) & ${nested('input')}`
				: own.input
			: nested('input'),
		output: own
			? children.length > 0
				? `(${own.output}) & ${nested('output')}`
				: own.output
			: nested('output'),
		sources,
	}
}

function findExpression(file: SourceFile, start: number, end: number): Node | undefined {
	let found: Node | undefined
	const visit = (node: Node) => {
		if (node.getStart(file) === start && node.getEnd() === end) found = node
		else if (node.pos <= start && node.end >= end) node.forEachChild(visit)
	}
	visit(file)
	return found
}

function schemaDependencies(
	project: Project,
	expression: Node,
	identify: (path: string) => string,
): ConfigSource['dependencies'] {
	const found = new Map<string, { source: string; name: string; declaration: string }>()
	const pending = [expression]
	while (pending.length > 0) {
		const node = pending.shift()!
		const visit = (current: Node) => {
			if (current.kind === SyntaxKind.Identifier) {
				let symbol = project.checker.getSymbolAtLocation(current)
				if (symbol && symbol.flags & SymbolFlags.Alias)
					symbol = project.checker.getAliasedSymbol(symbol)
				for (const handle of symbol?.declarations ?? []) {
					let declaration = handle.resolve()
					const file = declaration?.getSourceFile()
					const json = file?.scriptKind === ScriptKind.JSON
					if (
						!declaration ||
						file!.isDeclarationFile ||
						(!json &&
							![
								SyntaxKind.VariableDeclaration,
								SyntaxKind.FunctionDeclaration,
								SyntaxKind.ClassDeclaration,
							].includes(declaration.kind))
					)
						continue
					if (declaration.kind === SyntaxKind.VariableDeclaration)
						declaration = declaration.parent.parent
					const source = identify(file!.fileName)
					const name = json ? 'default' : symbol!.name
					const key = `${source}#${name}`
					if (found.has(key)) continue
					if (found.size >= 256)
						fail('Config declaration dependency budget exceeded (256 declarations)')
					found.set(key, {
						source,
						name,
						declaration: json ? file!.text : declaration.getFullText().trim(),
					})
					if (!json) pending.push(declaration)
				}
			}
			current.forEachChild(visit)
		}
		visit(node)
	}
	return [...found.values()]
}

function findConfig(file: string): string | undefined {
	let directory = existsSync(file) && !extname(file) ? resolve(file) : dirname(resolve(file))
	while (true) {
		const config = resolve(directory, 'tsconfig.json')
		if (existsSync(config)) return config
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

async function emitDeclarations(options: {
	temporary: string
	root: string
	projectConfig?: string
	config: string
	names: readonly string[]
	jsonFiles: ReadonlySet<string>
	captured: ReadonlyMap<string, string>
	realpaths: ReadonlyMap<string, string>
	typeRoots?: readonly string[]
	customConditions?: readonly string[]
	signal?: AbortSignal
}): Promise<Map<string, string>> {
	const mirror = resolve(options.temporary, 'fs'),
		output = resolve(options.temporary, 'declarations')
	const mirrorPath = (path: string) => resolve(mirror, posix(resolve(path)).replace(/^\/+/, ''))
	for (const [path, content] of options.captured) {
		const target = mirrorPath(path)
		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, content)
	}
	for (const [path, actual] of options.realpaths) {
		if (path === actual || existsSync(mirrorPath(path))) continue
		const target = mirrorPath(path)
		await mkdir(dirname(target), { recursive: true })
		await symlink(mirrorPath(actual), target).catch((error) => {
			if (error.code !== 'EEXIST') throw error
		})
	}
	// Default type-reference roots follow the config directory. Preserve the analyzed
	// project's location inside the frozen filesystem instead of resolving from tmpdir.
	const config = mirrorPath(options.config)
	await writeFile(
		config,
		JSON.stringify({
			...(options.projectConfig ? { extends: mirrorPath(options.projectConfig) } : {}),
			files: options.names.map(mirrorPath),
			include: [],
			compilerOptions: {
				...(options.projectConfig ? {} : { target: 'ES2023' }),
				module: 'ESNext',
				moduleResolution: 'bundler',
				experimentalDecorators: true,
				customConditions: options.customConditions,
				noLib: false,
				lib: [],
				types: [],
				typeRoots: options.typeRoots?.map(mirrorPath),
				noEmit: false,
				declaration: true,
				emitDeclarationOnly: true,
				declarationMap: false,
				sourceMap: false,
				noEmitOnError: true,
				incremental: false,
				composite: false,
				rootDir: mirror,
				outDir: output,
				skipLibCheck: true,
				allowImportingTsExtensions: true,
			},
		}),
	)
	const require = createRequire(import.meta.url)
	try {
		await exec(
			process.execPath,
			[
				resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
				'--project',
				config,
				'--pretty',
				'false',
			],
			{ cwd: options.root, signal: options.signal, maxBuffer: 1024 * 1024 },
		)
	} catch (error) {
		fail(
			`Native declaration emit failed (${options.names.length} files; ${options.names.filter((file) => file.includes('@types/node')).length} Node declarations; ${options.names.filter((file) => file.includes('esnext.disposable')).length} disposable libraries):\n${String(error.stdout || error.stderr || error.message).slice(0, 6000)}`,
		)
	}
	const files = new Map<string, string>()
	for (const source of options.names) {
		if (options.jsonFiles.has(source) || /\.d\.(?:ts|mts|cts)$/.test(source)) {
			files.set(source, options.captured.get(source) ?? readFileSync(source, 'utf8'))
			continue
		}
		if (!/\.[cm]?tsx?$/.test(source)) continue
		const declaration = source.replace(/\.([cm]?)tsx?$/, '.d.$1ts')
		const target = resolve(output, posix(declaration).replace(/^\/+/, ''))
		if (!existsSync(target)) fail(`Native emitter omitted ${source}`)
		files.set(source, await readFile(target, 'utf8'))
	}
	return files
}

function basenameDeclaration(path: string): string {
	return path.slice(path.lastIndexOf(sep) + 1).replace(/(?:\.d)?\.([cm]?)tsx?$/, '.d.$1ts')
}

/** Read syntax nodes rather than matching examples, strings or comments that mention import. */
function declarationReferences(
	code: string,
	filename: string,
): { specifier: string; start: number; end: number; kind: 'module' | 'path' }[] {
	const parsed = parseSync(filename, code, { sourceType: 'module' })
	if (parsed.errors.length > 0)
		fail(`Cannot read declaration references in ${filename}: ${parsed.errors[0]!.message}`)
	const references: { specifier: string; start: number; end: number; kind: 'module' | 'path' }[] =
		[]
	const visit = (value: unknown): void => {
		if (!value || typeof value !== 'object') return
		if (Array.isArray(value)) {
			for (const node of value) visit(node)
			return
		}
		const node = value as Record<string, unknown>
		const source = [
			'ImportDeclaration',
			'ExportNamedDeclaration',
			'ExportAllDeclaration',
			'TSImportType',
		].includes(node.type as string)
			? node.source
			: node.type === 'TSExternalModuleReference'
				? node.expression
				: node.type === 'TSModuleDeclaration'
					? node.id
					: undefined
		if (source && typeof source === 'object') {
			const literal = source as Record<string, unknown>
			if (
				literal.type === 'Literal' &&
				typeof literal.value === 'string' &&
				typeof literal.start === 'number' &&
				typeof literal.end === 'number'
			) {
				references.push({
					specifier: literal.value,
					start: literal.start,
					end: literal.end,
					kind: 'module',
				})
			}
		}
		for (const child of Object.values(node)) visit(child)
	}
	visit(parsed.program)
	for (const match of code.matchAll(
		/^[\t ]*\/\/\/[\t ]*<reference\b[^>\r\n]*\bpath\s*=\s*(["'])([^"'\r\n]+)\1[^>]*>/dgm,
	)) {
		const [start, end] = match.indices![2]!
		const specifier = match[2]!
		references.push({
			specifier: specifier.startsWith('.') || isAbsolute(specifier) ? specifier : `./${specifier}`,
			start: start - 1,
			end: end + 1,
			kind: 'path',
		})
	}
	return references
}

const escapeComment = (text: string): string =>
	text.replaceAll('*/', '* /').replaceAll('\n', '\n * ')
function readonlyLiteral(value: unknown): string {
	if (Array.isArray(value)) return `readonly [${value.map(readonlyLiteral).join(', ')}]`
	if (value && typeof value === 'object')
		return `{ ${Object.entries(value)
			.map(([key, item]) => `readonly ${JSON.stringify(key)}: ${readonlyLiteral(item)}`)
			.join('; ')} }`
	return JSON.stringify(value)
}
function normalizeDeclaration(code: string, filename: string): unknown {
	const parsed = parseSync(filename, code, { sourceType: 'module' })
	if (parsed.errors.length > 0)
		fail(`Cannot normalize declaration ${filename}: ${parsed.errors[0]!.message}`)
	return normalizeAst(parsed.program)
}
function normalizeAst(value: unknown): unknown {
	if (typeof value === 'bigint') return { bigint: value.toString() }
	if (Array.isArray(value)) return value.map(normalizeAst)
	if (!value || typeof value !== 'object') return value
	const output: Record<string, unknown> = {}
	for (const key of Object.keys(value).sort())
		if (
			![
				'start',
				'end',
				'loc',
				'range',
				'comments',
				'leadingComments',
				'trailingComments',
				'innerComments',
				'raw',
				'tokens',
			].includes(key)
		)
			output[key] = normalizeAst((value as Record<string, unknown>)[key])
	return output
}
function normalizeType(code: string): unknown {
	return normalizeDeclaration(`type Contract = ${code}`, 'contract.d.ts')
}
function normalizeExpression(code: string): unknown {
	return normalizeDeclaration(`const schema = ${code}`, 'schema.ts')
}
function normalizeSource(code: string, source: string): unknown {
	if (source.endsWith('.json')) return { json: code }
	return normalizeDeclaration(code, 'source.ts')
}
function normalizeSchemaDeclaration(code: string, helper: string): unknown {
	const program = parseSync('schema.d.ts', code, { sourceType: 'module' }).program
	for (const statement of program.body) {
		const declaration =
			statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
		if (declaration?.type !== 'VariableDeclaration') continue
		for (const item of declaration.declarations)
			if (item.id.type === 'Identifier' && item.id.name === helper)
				return normalizeAst(item.id.typeAnnotation)
	}
	return fail(`Native schema declaration missing: ${helper}`)
}
