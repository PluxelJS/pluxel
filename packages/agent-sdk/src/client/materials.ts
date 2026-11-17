import { checkAbort } from './signal'
import { randomUUID, createHash } from 'node:crypto'
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parsePluginDefinitionAddress, parsePluginEntryAddress } from '@pluxel/core'
import {
	isControlExportName,
	encodeControlData,
	parsePluginControlManifest,
	renderPluginDescriptors,
	verifyPluginControlMaterial,
	type PluginControlManifest,
} from '@pluxel/host/internal/control-manifest'
import {
	ScriptExecutionError,
	parsePluginControlManifestIndex,
	parsePluginControlFileChunk,
	type PluginControlManifestIndex,
	type PluginControlManifestRequest,
	type PluginControlFileRequest,
	type PluginControlFileChunk,
} from '@pluxel/host/internal/agent/runtime'

type PluginDefinitionAddress = PluginControlManifest['definitions'][number]['definition']
const definitionKey = (definition: PluginDefinitionAddress) => encodeControlData(definition)
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

export interface ControlMaterialSource {
	manifest(input?: PluginControlManifestRequest): Promise<PluginControlManifestIndex>
	file(input: PluginControlFileRequest): PluginControlFileChunk | Promise<PluginControlFileChunk>
}
/** Omit both fields to synchronize all committed definitions. */
export type ControlSyncSelection = Readonly<
	| {
			/** Exact npm package name, including definitions from its subpaths. */
			packageName?: string
			definition?: never
	  }
	| {
			packageName?: never
			/** One exact standard definition address, including source-entry definitions. */
			definition?: PluginDefinitionAddress
	  }
>
export type ControlSyncResult = Readonly<{
	out: string
	snapshot: string
	catalogRevision: number
	unavailableCount: number
	definitions: readonly ControlSyncExport[]
	services: readonly ControlSyncExport[]
}>
type ControlSyncExport = Readonly<{
	definition: PluginDefinitionAddress
	exportName: string
	module: string
	/** Complete import using this module path and generated export name. */
	importStatement: string
}>
const MAX_BYTES = 64 * 1024 * 1024
const OWNER_FILE = '.pluxel-control-owner.json'
const OWNER_CONTENT = '{"format":"pluxel-control-sync/3"}\n'
const sha256 = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex')
const failure = (code: string, message: string) => new ScriptExecutionError(code, message)

/** Validate and fix the optional selection before opening a target or downloading material. */
export function parseControlSyncSelection(
	input: Readonly<{ packageName?: unknown; definition?: unknown }>,
): ControlSyncSelection {
	const { packageName, definition } = input
	if (packageName !== undefined && definition !== undefined)
		throw failure('invalid_input', 'Choose packageName or definition for control synchronization')
	try {
		if (definition !== undefined)
			return Object.freeze({ definition: parsePluginDefinitionAddress(definition) })
		if (packageName !== undefined) {
			if (typeof packageName !== 'string') throw new TypeError('packageName must be a string')
			parsePluginEntryAddress({ kind: 'package-root', packageName })
			return Object.freeze({ packageName })
		}
		return Object.freeze({})
	} catch (error) {
		throw failure(
			'invalid_input',
			error instanceof Error ? error.message : 'Invalid control synchronization selection',
		)
	}
}

/** Download an immutable snapshot completely before changing the tool-owned import pointer. */
export async function syncPluginControl(
	options: ControlSyncSelection &
		Readonly<{ source: ControlMaterialSource; out: string; signal?: AbortSignal }>,
): Promise<ControlSyncResult> {
	checkAbort(options.signal)
	const out = resolve(options.out)
	if (out.includes('?') || (sep === '/' && out.includes('\\')))
		throw failure(
			'invalid_input',
			'TypeScript/Rolldown cannot import control modules from an output path containing ? or a POSIX backslash',
		)
	const requested = parseControlSyncSelection(options)
	const transport: ControlMaterialSource = {
		manifest: async (input) => {
			checkAbort(options.signal)
			return options.source.manifest(input)
		},
		file: async (input) => {
			checkAbort(options.signal)
			return options.source.file(input)
		},
	}
	const first = parsePluginControlManifestIndex(await transport.manifest())
	const index = [...first.definitions]
	const serviceIndex = [...first.services]
	let offset = first.nextOffset
	while (offset !== null) {
		const page = parsePluginControlManifestIndex(
			await transport.manifest({ transfer: first.transfer, offset }),
		)
		if (
			page.transfer !== first.transfer ||
			page.catalogRevision !== first.catalogRevision ||
			page.expiresAt !== first.expiresAt ||
			page.unavailableCount !== first.unavailableCount ||
			encodeControlData(page.materials) !== encodeControlData(first.materials) ||
			(page.nextOffset !== null && page.nextOffset <= offset)
		)
			throw failure(
				'control_contract_mismatch',
				'The control material index changed during synchronization',
			)
		index.push(...page.definitions)
		serviceIndex.push(...page.services)
		if (index.length + serviceIndex.length > 4096)
			throw failure('control_material_limit', 'The control definition index exceeds 4096 entries')
		offset = page.nextOffset
	}
	const requestedDefinition = requested.definition && definitionKey(requested.definition)
	const matches = ({ definition }: { definition: PluginDefinitionAddress }) =>
		requestedDefinition !== undefined
			? definitionKey(definition) === requestedDefinition
			: requested.packageName !== undefined
				? definition.entry.kind !== 'source-entry' &&
					definition.entry.packageName === requested.packageName
				: true
	const selection = index.filter(matches)
	const serviceSelection = serviceIndex.filter(matches)
	if (
		selection.length + serviceSelection.length === 0 &&
		(requested.packageName !== undefined || requested.definition !== undefined)
	)
		throw failure(
			'control_definition_not_found',
			'No committed control material matches the selected definition or package',
		)
	const needed = new Set([...selection, ...serviceSelection].map(({ snapshot }) => snapshot))
	const snapshots = first.materials.filter(({ snapshot }) => needed.has(snapshot))
	let total = snapshots.reduce((sum, item) => sum + item.manifestSize, 0)
	if (total > MAX_BYTES) throw failure('control_material_limit', 'Control manifests exceed 64 MiB')
	const materials = new Map<
		string,
		{ manifest: PluginControlManifest; files: Record<string, string> }
	>()
	for (const item of snapshots) {
		const manifestText = await download(
			transport,
			item.snapshot,
			'manifest.json',
			item.manifestSize,
		)
		let raw: unknown
		try {
			raw = JSON.parse(manifestText)
		} catch {
			throw failure('control_contract_mismatch', 'Control manifest is not valid JSON')
		}
		const manifest = parsePluginControlManifest(raw)
		if (manifest.snapshot !== item.snapshot)
			throw failure('control_contract_mismatch', 'Downloaded manifest belongs to another snapshot')
		total += manifest.files.reduce((sum, file) => sum + file.size, 0)
		if (total > MAX_BYTES) throw failure('control_material_limit', 'Control files exceed 64 MiB')
		const files: Record<string, string> = Object.create(null)
		files['manifest.json'] = manifestText
		for (const file of manifest.files)
			files[file.path] = await download(transport, item.snapshot, file.path, file.size)
		await verifyPluginControlMaterial(manifest, files)
		materials.set(item.snapshot, { manifest, files })
	}

	const files: Record<string, string> = Object.create(null)
	for (const [snapshot, material] of materials) {
		const prefix = `materials/${snapshot.slice(7)}`
		for (const [path, content] of Object.entries(material.files)) {
			// Providers are emitted once in their canonical entry modules. Preserve the
			// verified declaration closure and data, without unreachable runtime copies.
			if (path === 'manifest.json' || path.endsWith('.mjs')) continue
			files[`${prefix}/${path}`] = content
		}
	}
	const selected = new Set<string>()
	const entryKeys = new Map<string, string>()
	const namesByModule = new Map<string, Set<string>>()
	const layout = (definition: PluginDefinitionAddress, kind: 'Plugin' | 'Service') => {
		const key = definitionKey(definition)
		const selectedKey = `${kind}:${key}`
		if (selected.has(selectedKey))
			throw failure(
				'control_contract_mismatch',
				`A committed ${kind} definition appears more than once`,
			)
		selected.add(selectedKey)
		const entryKey = encodeControlData(definition.entry)
		const digest = sha256(entryKey)
		if (entryKeys.has(digest) && entryKeys.get(digest) !== entryKey)
			throw failure(
				'control_contract_mismatch',
				'Canonical entries collide in the generated module layout',
			)
		entryKeys.set(digest, entryKey)
		const module = `entries/${digest}/index.mjs`
		let names = namesByModule.get(module)
		if (!names) namesByModule.set(module, (names = new Set()))
		const suffixes =
			kind === 'Plugin'
				? ['ConfigDeclaration', 'ConfigInput', 'ConfigOutput', 'Instance']
				: ['Instance']
		const family = (name: string) => [name, ...suffixes.map((suffix) => `${name}${suffix}`)]
		let exportName = definition.exportName
		if (!isControlExportName(exportName) || family(exportName).some((name) => names.has(name)))
			exportName = `${kind}_${sha256(key)}`
		if (family(exportName).some((name) => names.has(name)))
			throw failure('control_contract_mismatch', 'Control exports collide in one canonical entry')
		for (const name of family(exportName)) names.add(name)
		return { exportName, module }
	}
	const exports = selection
		.sort((left, right) => compare(definitionKey(left.definition), definitionKey(right.definition)))
		.map((entry) => {
			const key = definitionKey(entry.definition)
			const material = materials.get(entry.snapshot)
			const definition = material?.manifest.definitions.find(
				(item) => definitionKey(item.definition) === key && item.exportName === entry.exportName,
			)
			if (!definition)
				throw failure(
					'control_contract_mismatch',
					'The selected Plugin definition is absent from its material snapshot',
				)
			const { exportName, module } = layout(entry.definition, 'Plugin')
			return {
				definition: entry.definition,
				exportName,
				module,
				contracts: definition.contracts,
				source: `materials/${entry.snapshot.slice(7)}/${definition.module.replace(/\.mjs$/, '.d.mts')}`,
				originalModule: definition.module,
				originalExport: entry.exportName,
				snapshot: entry.snapshot,
			}
		})
	const serviceExports = serviceSelection
		.sort((left, right) => compare(definitionKey(left.definition), definitionKey(right.definition)))
		.map((entry) => {
			const key = definitionKey(entry.definition)
			const material = materials.get(entry.snapshot)
			const service = material?.manifest.services.find(
				(item) => definitionKey(item.definition) === key && item.exportName === entry.exportName,
			)
			if (!service)
				throw failure(
					'control_contract_mismatch',
					'The selected service definition is absent from its material snapshot',
				)
			const { exportName, module } = layout(entry.definition, 'Service')
			return {
				definition: entry.definition,
				exportName,
				module,
				contract: service.contract,
				access: service.access,
				source: `materials/${entry.snapshot.slice(7)}/${service.module.replace(/\.mjs$/, '.d.mts')}`,
				originalModule: service.module,
				originalExport: entry.exportName,
				snapshot: entry.snapshot,
			}
		})
	for (const module of namesByModule.keys()) {
		const definitions = exports.filter((entry) => entry.module === module)
		const services = serviceExports.filter((entry) => entry.module === module)
		files[module] = renderPluginDescriptors(
			definitions.map((entry) => ({
				exportName: entry.exportName,
				descriptor: { format: 2, definition: entry.definition, contracts: entry.contracts },
			})),
			services.map((entry) => ({
				exportName: entry.exportName,
				descriptor: {
					format: 1,
					definition: entry.definition,
					contract: entry.contract,
					access: entry.access,
				},
			})),
		)
		files[module.replace(/\.mjs$/, '.d.mts')] =
			definitions
				.map((entry) => {
					const path = JSON.stringify(
						`../../materials/${entry.snapshot.slice(7)}/${entry.originalModule}`,
					)
					return `export { ${entry.originalExport} as ${entry.exportName} } from ${path};\nexport type { ${['ConfigDeclaration', 'ConfigInput', 'ConfigOutput', 'Instance'].map((suffix) => `${entry.originalExport}${suffix} as ${entry.exportName}${suffix}`).join(', ')} } from ${path};\n`
				})
				.join('') +
			services
				.map((entry) => {
					const path = JSON.stringify(
						`../../materials/${entry.snapshot.slice(7)}/${entry.originalModule}`,
					)
					return `export { ${entry.originalExport} as ${entry.exportName} } from ${path};\nexport type { ${entry.originalExport}Instance as ${entry.exportName}Instance } from ${path};\n`
				})
				.join('')
	}

	const unsigned = {
		format: 3 as const,
		compiler: '@pluxel/agent-sdk/control-sync/3',
		definitions: exports.map(({ definition, exportName, module, contracts, source }) => ({
			definition,
			exportName,
			module,
			contracts,
			source,
		})),
		services: serviceExports.map(
			({ definition, exportName, module, contract, access, source }) => ({
				definition,
				exportName,
				module,
				contract,
				access,
				source,
			}),
		),
		files: Object.entries(files)
			.sort(([a], [b]) => compare(a, b))
			.map(([path, content]) => ({
				path,
				size: Buffer.byteLength(content),
				sha256: sha256(content),
			})),
	}
	const manifest = { ...unsigned, snapshot: `sha256:${sha256(encodeControlData(unsigned))}` }
	files['manifest.json'] = `${encodeControlData(manifest)}\n`
	await verifyPluginControlMaterial(manifest, files)
	checkAbort(options.signal)
	// Publication settles atomically once started, including when the caller aborts.
	await installSnapshot(out, manifest.snapshot, files)
	const resultExports = (
		entries: readonly { definition: PluginDefinitionAddress; exportName: string; module: string }[],
	) =>
		Object.freeze(
			entries.map(({ definition, exportName, module }) => {
				const path = join(out, 'current', module)
				return Object.freeze({
					definition,
					exportName,
					module: path,
					importStatement: `import { ${exportName} } from ${JSON.stringify(path)};`,
				})
			}),
		)
	return Object.freeze({
		out,
		snapshot: manifest.snapshot,
		catalogRevision: first.catalogRevision,
		unavailableCount: first.unavailableCount,
		definitions: resultExports(exports),
		services: resultExports(serviceExports),
	})
}

async function download(
	source: ControlMaterialSource,
	snapshot: string,
	path: string,
	expectedSize: number,
): Promise<string> {
	if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_BYTES)
		throw failure('control_material_limit', 'Control file exceeds the synchronization budget')
	const bytes = Buffer.alloc(expectedSize)
	let offset = 0
	while (true) {
		const chunk = parsePluginControlFileChunk(await source.file({ snapshot, path, offset }))
		if (
			chunk.snapshot !== snapshot ||
			chunk.path !== path ||
			chunk.offset !== offset ||
			chunk.totalSize !== expectedSize
		)
			throw failure('control_contract_mismatch', 'Control file chunks belong to different content')
		Buffer.from(chunk.data, 'base64').copy(bytes, offset)
		offset = chunk.nextOffset
		if (chunk.done) break
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		throw failure('control_contract_mismatch', 'Control files must contain valid UTF-8')
	}
}

async function inspect(path: string) {
	try {
		return await lstat(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}
async function ownedDirectory(out: string): Promise<void> {
	await mkdir(dirname(out), { recursive: true })
	const existing = await inspect(out)
	if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
		throw failure('control_sync_conflict', 'The output must be a tool-owned directory')
	if (!existing) await mkdir(out)
	const owner = join(out, OWNER_FILE)
	const marker = await inspect(owner)
	if (!marker) {
		const entries = await readdir(out)
		if (entries.length > 0)
			throw failure(
				'control_sync_conflict',
				'The output contains author files; choose an empty directory',
			)
		await writeFile(owner, OWNER_CONTENT, { flag: 'wx' })
	} else if (
		!marker.isFile() ||
		marker.isSymbolicLink() ||
		marker.size !== Buffer.byteLength(OWNER_CONTENT) ||
		(await readFile(owner, 'utf8')) !== OWNER_CONTENT
	) {
		throw failure('control_sync_conflict', 'The output is owned by another tool or author')
	}
}
async function installSnapshot(
	out: string,
	snapshot: string,
	files: Readonly<Record<string, string>>,
): Promise<void> {
	await ownedDirectory(out)
	let lock
	try {
		lock = await open(join(out, '.sync.lock'), 'wx')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST')
			throw failure(
				'control_sync_busy',
				'Another synchronization owns this output; remove a stale .sync.lock only after checking that process',
			)
		throw error
	}
	let stage: string | undefined
	let temporaryLink: string | undefined
	try {
		const snapshots = join(out, '.snapshots')
		const folder = await inspect(snapshots)
		if (folder && (!folder.isDirectory() || folder.isSymbolicLink()))
			throw failure('control_sync_conflict', 'The snapshot store conflicts with an author file')
		await mkdir(snapshots, { recursive: true })
		const final = join(snapshots, snapshot.slice(7))
		if (await inspect(final)) await checkExisting(final, files)
		else {
			stage = await mkdtemp(join(snapshots, '.stage-'))
			for (const [path, content] of Object.entries(files)) {
				await mkdir(dirname(join(stage, path)), { recursive: true })
				await writeFile(join(stage, path), content, { flag: 'wx' })
			}
			await rename(stage, final)
			stage = undefined
		}
		const current = join(out, 'current')
		const previous = await inspect(current)
		if (previous) {
			if (!previous.isSymbolicLink())
				throw failure(
					'control_sync_conflict',
					'The current import path conflicts with an author file',
				)
			const link = await readlink(current)
			const target = link.replaceAll('\\', '/')
			if (process.platform !== 'win32' && !/^\.snapshots\/[a-f0-9]{64}$/.test(target))
				throw failure(
					'control_sync_conflict',
					'The current import pointer is not owned by this tool',
				)
		}
		temporaryLink = join(out, `.current-${randomUUID()}`)
		await symlink(
			process.platform === 'win32' ? final : `.snapshots/${snapshot.slice(7)}`,
			temporaryLink,
			process.platform === 'win32' ? 'junction' : 'dir',
		)
		await rename(temporaryLink, current)
		temporaryLink = undefined
	} finally {
		if (temporaryLink) await rm(temporaryLink, { force: true })
		if (stage) await rm(stage, { recursive: true, force: true })
		await lock.close()
		await rm(join(out, '.sync.lock'), { force: true })
	}
}
async function checkExisting(
	directory: string,
	files: Readonly<Record<string, string>>,
): Promise<void> {
	const root = await lstat(directory)
	if (!root.isDirectory() || root.isSymbolicLink())
		throw failure('control_sync_conflict', 'An existing immutable snapshot has been replaced')
	for (const [path, content] of Object.entries(files)) {
		const parts = path.split('/')
		for (let index = 1; index < parts.length; index++) {
			const folder = await inspect(join(directory, ...parts.slice(0, index)))
			if (!folder?.isDirectory() || folder.isSymbolicLink())
				throw failure('control_sync_conflict', 'An existing snapshot directory has been edited')
		}
		const file = await inspect(join(directory, path))
		if (
			!file?.isFile() ||
			file.isSymbolicLink() ||
			file.size !== Buffer.byteLength(content) ||
			(await readFile(join(directory, path), 'utf8')) !== content
		)
			throw failure(
				'control_sync_conflict',
				'An existing immutable snapshot has been edited; author changes were preserved',
			)
	}
}
