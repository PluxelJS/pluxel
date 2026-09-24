import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
	formatPluginNodeReference,
	parsePluginDefinitionAddress,
	parsePluginNodeReference,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import { ResolverFactory } from 'oxc-resolver'
import {
	inspectPluginPackage,
	type InspectedPluginPackage,
	type InspectedSemanticOwner,
} from '../rolldown/plugins/pluginSemanticsPlugin'
import { inspectOwnerConfigs } from './config'
import {
	discoverPackages,
	resolveInspectionPackage,
	type InspectionPackage as WorkspacePackage,
} from './workspace'
import {
	InspectionError,
	type Inspection,
	type InspectionConfigDeclaration,
	type InspectionDiagnostic,
	type InspectionFileOwner,
	type InspectionPage,
	type InspectionPageOptions,
	type InspectionQueryOptions,
	type InspectionPart,
	type InspectionPluginReport,
	type InspectionPluginSection,
	type InspectionPluginSummary,
	type InspectionScript,
	type InspectionSection,
	type InspectionSectionData,
	type InspectionSourceLocation,
	type OpenProjectOptions,
	type ProjectInspection,
} from './contracts'

const SECTIONS = new Set<InspectionPluginSection>(['parts', 'config', 'dependencies', 'checks'])
const MAX_FILES = 4096
const MAX_SOURCE_BYTES = 32 * 1024 * 1024
const MAX_OCCURRENCES = 2048
const MAX_OUTPUT_BYTES = 1024 * 1024

type ReadFile = Readonly<{ id: string; code: string }>
type Occurrence = {
	owner: InspectedSemanticOwner
	path: string[]
	mount?: InspectionSourceLocation
}
type LoadedPackage = { pkg: WorkspacePackage; semantic: InspectedPluginPackage }

/**
 * Open a read-only query scope. No project module, build hook or application is evaluated.
 * Queries reread source using fresh resolver state; dispose drains admitted work.
 */
export async function openProject(openOptions: OpenProjectOptions): Promise<ProjectInspection> {
	validateObject(openOptions, ['root', 'signal'])
	const selection = { ...openOptions }
	if (typeof selection.root !== 'string' || !selection.root.trim())
		invalid('root must be a non-empty path')
	checkSignal(selection.signal)
	let root: string
	try {
		root = await realpath(resolve(selection.root))
		await discoverPackages(root, { signal: selection.signal })
	} catch (cause) {
		checkSignal(selection.signal)
		throw normalizeError(cause, 'project_not_found')
	}
	checkSignal(selection.signal)
	let closed = false
	let admitted = 0
	let tail: Promise<void> = Promise.resolve()
	let disposal: Promise<void> | undefined

	const query = <T>(
		signal: AbortSignal | undefined,
		work: (snapshot: Snapshot) => Promise<T>,
	): Promise<Inspection<T>> => {
		try {
			checkSignal(signal)
			if (closed)
				throw new InspectionError('project_closed', 'The project query scope has been disposed.')
			if (admitted >= 17)
				throw new InspectionError(
					'query_queue_full',
					'At most one query can run and sixteen can wait.',
				)
		} catch (cause) {
			return Promise.reject(cause)
		}
		admitted++
		return new Promise((fulfill, reject) => {
			let aborted = false
			const onAbort = () => {
				aborted = true
				reject(
					new InspectionError('aborted', 'Project inspection was aborted.', {
						cause: signal?.reason,
					}),
				)
			}
			signal?.addEventListener('abort', onAbort, { once: true })
			const run = async () => {
				try {
					if (aborted) return
					if (closed)
						throw new InspectionError(
							'project_closed',
							'The project query scope has been disposed.',
						)
					const snapshot = new Snapshot(root, signal)
					const data = await work(snapshot)
					await snapshot.verify()
					const result = {
						root,
						revision: snapshot.revision(),
						data,
					}
					if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) {
						throw new InspectionError(
							'analysis_unavailable',
							'Inspection output exceeds 1 MiB. Select fewer sections, a Part subtree, or a smaller page.',
						)
					}
					fulfill(freeze(result))
				} catch (cause) {
					reject(normalizeError(cause))
				} finally {
					admitted--
					signal?.removeEventListener('abort', onAbort)
				}
			}
			tail = tail.then(run, run)
		})
	}

	const project: ProjectInspection = {
		root,
		async overview(input = {}) {
			validatePage(input)
			const options = { ...input }
			return query(options.signal, async (snapshot) => {
				const packages = await snapshot.packages()
				return {
					packages: page(
						packages.map((pkg) => ({
							name: typeof pkg.manifest.name === 'string' ? pkg.manifest.name : null,
							version: typeof pkg.manifest.version === 'string' ? pkg.manifest.version : null,
							root: pkg.root,
							manifest: pkg.manifestPath,
						})),
						options,
						`${root}:overview`,
						snapshot.revision(),
					),
					scripts: scripts(packages.find((pkg) => pkg.root === root)),
				}
			})
		},
		async plugins(input = {}) {
			validatePage(input, ['packageName'])
			const options = { ...input }
			if (
				options.packageName !== undefined &&
				(typeof options.packageName !== 'string' || !options.packageName.trim())
			)
				invalid('packageName must be a non-empty package name')
			return query(options.signal, async (snapshot) => {
				const packages = await snapshot.packages()
				const selected =
					options.packageName === undefined
						? packages
						: [await resolveInspectionPackage(root, options.packageName, packages)]
				const found: InspectionPluginSummary[] = []
				const gaps: InspectionDiagnostic[] = []
				for (const pkg of selected) {
					if (!hasExports(pkg)) continue
					try {
						const loaded = await snapshot.load(pkg)
						found.push(
							...loaded.semantic.definitions.map((definition) => summary(definition, snapshot)),
						)
					} catch (cause) {
						checkSignal(options.signal)
						if (normalizeError(cause).code === 'source_changed') throw cause
						gaps.push(diagnostic(cause, pkg.manifestPath))
					}
				}
				found.sort((a, b) => compare(a.reference, b.reference))
				if (options.packageName !== undefined && gaps.length > 0 && found.length === 0) {
					return { status: 'unavailable' as const, reason: gaps[0]! }
				}
				return section(
					page(
						found,
						options,
						`${root}:plugins:${options.packageName ?? ''}`,
						digest([snapshot.revision(), gaps]),
					),
					gaps,
				)
			})
		},
		async plugin<const S extends readonly InspectionPluginSection[] = readonly []>(
			target: PluginDefinitionAddress | string,
			input: InspectionQueryOptions & {
				readonly include?: S
				readonly partPath?: readonly string[]
			} = {},
		): Promise<Inspection<InspectionPluginReport<S>>> {
			validateObject(input, ['signal', 'include', 'partPath'])
			const options = { ...input }
			if (options.include !== undefined && !Array.isArray(options.include))
				invalid('include must be an array')
			const include = Array.from(options.include ?? [])
			if (include.some((name) => !SECTIONS.has(name)))
				invalid('include contains an unsupported inspection section')
			if (options.partPath !== undefined && !Array.isArray(options.partPath))
				invalid('partPath must be an array')
			const partPath = Array.from(options.partPath ?? [])
			if (partPath.some((part) => typeof part !== 'string' || !part))
				invalid('partPath must contain non-empty field names')
			const address = definitionTarget(target)
			if (address.entry.kind !== 'package-root')
				invalid('This inspection entry currently supports package-root Plugin definitions only.')
			const packageName = address.entry.packageName
			return query(options.signal, async (snapshot) => {
				const pkg = await resolveInspectionPackage(root, packageName, await snapshot.packages())
				const loaded = await snapshot.load(pkg)
				const definition = loaded.semantic.definitions.find((item) =>
					sameDefinition(item.definition, address),
				)
				if (!definition)
					throw new InspectionError(
						'plugin_not_found',
						`The package does not export ${address.exportName} as a Plugin.`,
						{ context: { packageName } },
					)
				const expanded = occurrences(loaded.semantic, definition, snapshot)
				if (!expanded.value.some((item) => samePath(item.path, partPath))) {
					if (expanded.gaps.length > 0)
						throw new InspectionError(
							'analysis_unavailable',
							'The requested Part path could not be resolved.',
							{ context: { partPath: JSON.stringify(partPath) } },
						)
					throw new InspectionError(
						'part_not_found',
						`Part path ${JSON.stringify(partPath)} was not found.`,
						{ context: { paths: JSON.stringify(expanded.value.map((item) => item.path)) } },
					)
				}
				const selected = expanded.value.filter((item) => isPathPrefix(partPath, item.path))
				const sections: Partial<{
					[K in InspectionPluginSection]: InspectionSection<InspectionSectionData[K]>
				}> = {}
				if (include.includes('parts')) {
					sections.parts = section(
						{
							occurrences: selected
								.filter((item) => item.mount)
								.map((item): InspectionPart => ({
									partPath: item.path,
									className: item.owner.className,
									declaration: snapshot.location(
										item.owner.moduleId,
										item.owner.start,
										item.owner.end,
									),
									mount: item.mount!,
									requires: item.owner.requires,
									optional: item.owner.optional,
								})),
						},
						expanded.gaps,
					)
				}
				if (include.includes('dependencies')) {
					const required = uniqueDefinitions(
						expanded.value.flatMap((item) => [...item.owner.requires]),
					)
					const requiredKeys = new Set(required.map(pluginDefinitionIndexKey))
					const optional = uniqueDefinitions(
						expanded.value.flatMap((item) => [...item.owner.optional]),
					).filter((item) => !requiredKeys.has(pluginDefinitionIndexKey(item)))
					sections.dependencies = section(
						{
							requires: required,
							optional,
							provides: definition.provides ?? null,
							origins: selected.map((item) => ({
								partPath: item.path,
								declaration: snapshot.location(
									item.owner.moduleId,
									item.owner.start,
									item.owner.end,
								),
								requires: item.owner.requires,
								optional: item.owner.optional,
							})),
						},
						expanded.gaps,
					)
				}
				if (include.includes('config')) {
					const configs = await snapshot.configs(loaded)
					sections.config = section(
						{ declarations: configDeclarations(configs, selected, snapshot) },
						[...expanded.gaps, ...configs.diagnostics],
					)
				}
				if (include.includes('checks')) sections.checks = section({ scripts: scripts(pkg) }, [])
				return { summary: summary(definition, snapshot), sections } as InspectionPluginReport<S>
			})
		},
		async file(path, input = {}) {
			validatePage(input)
			const options = { ...input }
			if (typeof path !== 'string' || !path) invalid('file path must be non-empty')
			return query(options.signal, async (snapshot) => {
				const file = await realpath(resolve(root, path)).catch((cause) => {
					throw new InspectionError('invalid_input', `Cannot read ${path}`, { cause })
				})
				await snapshot.read(file)
				const owners: InspectionFileOwner[] = []
				const gaps: InspectionDiagnostic[] = []
				for (const pkg of await snapshot.packages()) {
					if (!hasExports(pkg)) continue
					try {
						const loaded = await snapshot.load(pkg)
						const configs = await snapshot.configs(loaded)
						gaps.push(...configs.diagnostics)
						for (const definition of loaded.semantic.definitions) {
							const expanded = occurrences(loaded.semantic, definition, snapshot)
							gaps.push(...expanded.gaps)
							const relations: InspectionFileOwner['relations'][number][] = []
							for (const item of expanded.value) {
								const location = snapshot.location(
									item.owner.moduleId,
									item.owner.start,
									item.owner.end,
								)
								if (location.file === file)
									relations.push({
										kind: item.path.length > 0 ? 'part' : 'declaration',
										partPath: item.path,
										source: location,
									})
							}
							for (const config of configDeclarations(configs, expanded.value, snapshot)) {
								if (config.schema.declaration?.file === file)
									relations.push({
										kind: 'config-schema',
										partPath: config.partPath,
										source: config.schema.declaration,
									})
							}
							if (relations.length > 0)
								owners.push({
									definition: definition.definition,
									reference: reference(definition.definition),
									relations,
								})
						}
					} catch (cause) {
						checkSignal(options.signal)
						if (normalizeError(cause).code === 'source_changed') throw cause
						gaps.push(diagnostic(cause, pkg.manifestPath))
					}
				}
				owners.sort((a, b) => compare(a.reference, b.reference))
				return section(
					{
						file,
						scope: 'workspace-plugin-declarations' as const,
						...page(owners, options, `${root}:file:${file}`, digest([snapshot.revision(), gaps])),
					},
					gaps,
				)
			})
		},
		[Symbol.asyncDispose]() {
			closed = true
			disposal ??= tail
			return disposal
		},
	}
	return Object.freeze(project)
}

class Snapshot {
	readonly files = new Map<string, string>()
	private sourceBytes = 0
	private readonly resolver = new ResolverFactory({
		conditionNames: ['@pluxel/hmr', '@pluxel/source', 'development', 'node', 'import', 'default'],
		extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
		mainFields: ['module', 'main'],
		symlinks: true,
		tsconfig: 'auto',
	})
	constructor(
		readonly root: string,
		readonly signal?: AbortSignal,
	) {}
	async read(file: string): Promise<string> {
		checkSignal(this.signal)
		const code = await readBounded(file, this.signal)
		this.observe([{ id: file, code }])
		return code
	}
	observe(files: readonly ReadFile[]): void {
		checkSignal(this.signal)
		for (const { id, code } of files) {
			const previous = this.files.get(id)
			if (previous !== undefined && previous !== code)
				throw new InspectionError('source_changed', `Source changed during inspection: ${id}`)
			if (previous === undefined) this.sourceBytes += Buffer.byteLength(code)
			this.files.set(id, code)
			if (this.files.size > MAX_FILES || this.sourceBytes > MAX_SOURCE_BYTES)
				throw new InspectionError(
					'analysis_unavailable',
					'Inspection source budget exceeded (4096 files / 32 MiB). Select a package instead of the entire workspace.',
				)
		}
	}
	async packages(): Promise<readonly WorkspacePackage[]> {
		checkSignal(this.signal)
		try {
			await this.read(resolve(this.root, 'pnpm-workspace.yaml'))
		} catch (cause) {
			if (!isMissing(cause)) throw cause
		}
		const packages = await discoverPackages(this.root, { signal: this.signal })
		this.observe(packages.map((pkg) => ({ id: pkg.manifestPath, code: pkg.source })))
		return packages
	}
	resolve = async (source: string, importer: string): Promise<string | undefined> => {
		checkSignal(this.signal)
		const result = this.resolver.sync(dirname(importer), source)
		return result.path ? await realpath(result.path) : undefined
	}
	async load(pkg: WorkspacePackage): Promise<LoadedPackage> {
		this.observe([{ id: pkg.manifestPath, code: pkg.source }])
		const semantic = await inspectPluginPackage({
			packageJsonPath: pkg.manifestPath,
			resolve: this.resolve,
			signal: this.signal,
		})
		this.observe(semantic.files)
		return { pkg, semantic }
	}
	async configs(loaded: LoadedPackage) {
		const files = loaded.semantic.files.filter(
			(file) => /\.(?:[cm]?[jt]sx?)$/.test(file.id) && !/\.d\.[cm]?ts$/.test(file.id),
		)
		const result = await inspectOwnerConfigs(files, this.resolve, { signal: this.signal })
		this.observe(result.files)
		return result
	}
	location(file: string, start: number, end: number): InspectionSourceLocation {
		const code = this.files.get(file)
		if (code === undefined)
			throw new InspectionError('analysis_unavailable', `No observed source for ${file}`)
		return { file, start: position(code, start), end: position(code, end) }
	}
	revision(): string {
		return digest(['inspection-v1', this.root, [...this.files].sort(([a], [b]) => compare(a, b))])
	}
	async verify(): Promise<void> {
		for (const [file, code] of this.files) {
			checkSignal(this.signal)
			if ((await readBounded(file, this.signal).catch((): null => null)) !== code)
				throw new InspectionError('source_changed', `Source changed during inspection: ${file}`)
		}
		checkSignal(this.signal)
	}
}

function occurrences(
	semantic: InspectedPluginPackage,
	definition: InspectedPluginPackage['definitions'][number],
	snapshot: Snapshot,
): { value: Occurrence[]; gaps: InspectionDiagnostic[] } {
	const byKey = new Map(
		semantic.owners.map((owner) => [`${owner.moduleId}\0${owner.className}`, owner]),
	)
	const value: Occurrence[] = []
	const gaps: InspectionDiagnostic[] = []
	const visit = (
		moduleId: string,
		className: string,
		path: string[],
		active: Set<string>,
		mount?: InspectionSourceLocation,
	): void => {
		const key = `${moduleId}\0${className}`
		const owner = byKey.get(key)
		if (!owner) {
			gaps.push({
				code: 'part_source_unavailable',
				message: `Cannot resolve ${className}`,
				file: moduleId,
			})
			return
		}
		if (active.has(key) || path.length > 64 || value.length >= MAX_OCCURRENCES)
			throw new InspectionError(
				'analysis_unavailable',
				'Part containment is cyclic or exceeds the inspection budget (depth 64 / 2048 occurrences).',
			)
		value.push({ owner, path, ...(mount ? { mount } : {}) })
		const next = new Set(active).add(key)
		for (const part of owner.parts) {
			if (!part.target) {
				gaps.push({
					code: 'part_source_unavailable',
					message: `Cannot inspect external Part ${part.partName} at ${JSON.stringify([...path, part.fieldName])}`,
					file: moduleId,
				})
				continue
			}
			visit(
				part.target.moduleId,
				part.target.className,
				[...path, part.fieldName],
				next,
				snapshot.location(moduleId, part.start, part.end),
			)
		}
	}
	visit(definition.moduleId, definition.className, [], new Set())
	return { value, gaps }
}

function configDeclarations(
	configs: Awaited<ReturnType<typeof inspectOwnerConfigs>>,
	selected: readonly Occurrence[],
	snapshot: Snapshot,
): InspectionConfigDeclaration[] {
	const declarations: InspectionConfigDeclaration[] = []
	for (const item of selected) {
		for (const config of configs.declarations) {
			if (config.moduleId !== item.owner.moduleId || config.className !== item.owner.className)
				continue
			declarations.push({
				partPath: item.path,
				configPath: item.path,
				fieldName: config.fieldName,
				declaration: snapshot.location(config.moduleId, config.start, config.end),
				schema: {
					expression: config.schema.expression,
					usage: snapshot.location(config.schema.moduleId, config.schema.start, config.schema.end),
					declaration: config.schema.declaration
						? snapshot.location(
								config.schema.declaration.moduleId,
								config.schema.declaration.start,
								config.schema.declaration.end,
							)
						: config.schema.inline
							? snapshot.location(config.schema.moduleId, config.schema.start, config.schema.end)
							: null,
					symbol: config.schema.declaration?.symbol ?? null,
				},
			})
		}
	}
	return declarations
}

function summary(
	definition: InspectedPluginPackage['definitions'][number],
	snapshot: Snapshot,
): InspectionPluginSummary {
	return {
		definition: definition.definition,
		reference: reference(definition.definition),
		exportName: definition.definition.exportName,
		className: definition.className,
		kind: definition.kind,
		declaration: snapshot.location(definition.moduleId, definition.start, definition.end),
	}
}
function reference(definition: PluginDefinitionAddress): string {
	return formatPluginNodeReference({ definition, variant: 'default' })
}
function definitionTarget(target: PluginDefinitionAddress | string): PluginDefinitionAddress {
	try {
		if (typeof target !== 'string') return parsePluginDefinitionAddress(target)
		const node = parsePluginNodeReference(target)
		if (node.variant !== 'default')
			throw new InspectionError(
				'definition_required',
				'Offline source inspection requires a definition, not a fork reference.',
			)
		return node.definition
	} catch (cause) {
		if (cause instanceof InspectionError) throw cause
		throw new InspectionError(
			'invalid_input',
			'Expected a canonical Plugin definition address or default node reference.',
			{ cause },
		)
	}
}
function scripts(pkg: WorkspacePackage | undefined): InspectionScript[] {
	if (!pkg) return []
	const value = pkg.manifest.scripts
	if (!value || typeof value !== 'object' || Array.isArray(value)) return []
	return Object.entries(value)
		.filter((entry): entry is [string, string] => typeof entry[1] === 'string')
		.sort(([a], [b]) => compare(a, b))
		.map(([name, command]) => ({ name, command, cwd: pkg.root, manifest: pkg.manifestPath }))
}
function hasExports(pkg: WorkspacePackage): boolean {
	const entries = pkg.manifest.exports
	if (entries === undefined) return false
	if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
		const keys = Object.keys(entries)
		// A package exposing only subpaths cannot contain a public package-root Plugin.
		if (keys.some((key) => key.startsWith('.')) && !keys.includes('.')) return false
	}
	return true
}
function section<T>(value: T, gaps: readonly InspectionDiagnostic[]): InspectionSection<T> {
	return gaps.length > 0 ? { status: 'partial', value, gaps } : { status: 'complete', value }
}
function diagnostic(cause: unknown, file: string): InspectionDiagnostic {
	return {
		code: cause instanceof InspectionError ? cause.code : 'analysis_unavailable',
		message: cause instanceof Error ? cause.message : String(cause),
		file,
	}
}
function page<T>(
	items: readonly T[],
	options: InspectionPageOptions,
	key: string,
	revision: string,
): InspectionPage<T> {
	const signature = digest([key, revision, items])
	let offset = 0
	if (options.cursor !== undefined) {
		try {
			const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as {
				version?: unknown
				signature?: unknown
				offset?: unknown
				key?: unknown
			}
			if (
				cursor.version !== 1 ||
				cursor.key !== key ||
				!Number.isSafeInteger(cursor.offset) ||
				(cursor.offset as number) < 0
			)
				invalid('Invalid inspection cursor')
			if (cursor.signature !== signature)
				throw new InspectionError(
					'cursor_stale',
					'Query inputs changed; request the first page again.',
				)
			offset = cursor.offset as number
			if (offset > items.length) invalid('Invalid inspection cursor offset')
		} catch (cause) {
			if (cause instanceof InspectionError) throw cause
			invalid('Invalid inspection cursor')
		}
	}
	const limit = options.limit ?? 50
	const end = Math.min(offset + limit, items.length)
	return {
		items: items.slice(offset, end),
		nextCursor:
			end < items.length
				? Buffer.from(JSON.stringify({ version: 1, key, signature, offset: end })).toString(
						'base64url',
					)
				: null,
	}
}
function validatePage(options: InspectionPageOptions, extra: readonly string[] = []): void {
	validateObject(options, ['signal', 'limit', 'cursor', ...extra])
	if (
		options.limit !== undefined &&
		(!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)
	)
		invalid('limit must be an integer from 1 to 200')
	if (
		options.cursor !== undefined &&
		(typeof options.cursor !== 'string' || options.cursor.length > 2048)
	)
		invalid('cursor must be a bounded string returned by inspection')
}
function validateObject(value: unknown, keys: readonly string[]): void {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		invalid('Expected an options object')
	for (const key of Object.keys(value))
		if (!keys.includes(key)) invalid(`Unknown inspection option: ${key}`)
}
function invalid(message: string): never {
	throw new InspectionError('invalid_input', message)
}
function checkSignal(signal?: AbortSignal): void {
	if (signal !== undefined && !(signal instanceof AbortSignal))
		invalid('signal must be an AbortSignal')
	if (signal?.aborted)
		throw new InspectionError('aborted', 'Project inspection was aborted.', {
			cause: signal.reason,
		})
}
function normalizeError(
	cause: unknown,
	fallback: 'analysis_unavailable' | 'project_not_found' = 'analysis_unavailable',
): InspectionError {
	if (cause instanceof InspectionError) return cause
	const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
	const workspaceCodes = [
		'invalid_input',
		'project_not_found',
		'package_not_found',
		'ambiguous_package',
		'analysis_unavailable',
		'source_changed',
		'aborted',
	] as const
	const known = workspaceCodes.find((item) => item === code)
	return new InspectionError(
		known ?? fallback,
		cause instanceof Error ? cause.message : String(cause),
		{ cause },
	)
}
function isMissing(cause: unknown): boolean {
	return !!cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT'
}
async function readBounded(file: string, signal?: AbortSignal): Promise<string> {
	checkSignal(signal)
	const stream = createReadStream(file, { signal, highWaterMark: 64 * 1024 })
	const chunks: Buffer[] = []
	let bytes = 0
	try {
		for await (const chunk of stream) {
			const buffer = chunk as Buffer
			bytes += buffer.byteLength
			if (bytes > MAX_SOURCE_BYTES)
				throw new InspectionError('analysis_unavailable', `Source file exceeds 32 MiB: ${file}`)
			chunks.push(buffer)
		}
	} finally {
		stream.destroy()
	}
	return Buffer.concat(chunks, bytes).toString('utf8')
}
function position(code: string, offset: number): { line: number; column: number } {
	const prefix = code.slice(0, offset)
	const lines = prefix.split('\n')
	return { line: lines.length, column: lines[lines.length - 1]!.length + 1 }
}
function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}
function samePath(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && isPathPrefix(a, b)
}
function isPathPrefix(a: readonly string[], b: readonly string[]): boolean {
	return a.every((part, index) => b[index] === part)
}
function sameDefinition(a: PluginDefinitionAddress, b: PluginDefinitionAddress): boolean {
	return pluginDefinitionIndexKey(a) === pluginDefinitionIndexKey(b)
}
function uniqueDefinitions(values: readonly PluginDefinitionAddress[]): PluginDefinitionAddress[] {
	return [...new Map(values.map((item) => [pluginDefinitionIndexKey(item), item])).values()]
}
function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function freeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child)
		Object.freeze(value)
	}
	return value
}
