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
import { dirname, join, resolve } from 'node:path'
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
export type ControlSyncResult = Readonly<{
	out: string
	snapshot: string
	catalogRevision: number
	unavailableCount: number
	definitions: readonly Readonly<{
		definition: PluginDefinitionAddress
		exportName: string
		module: string
	}>[]
}>
const MAX_BYTES = 64 * 1024 * 1024
const OWNER_FILE = '.pluxel-control-owner.json'
const OWNER_CONTENT = '{"format":"pluxel-control-sync/2"}\n'
const sha256 = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex')
const failure = (code: string, message: string) => new ScriptExecutionError(code, message)

/** Download an immutable snapshot completely before changing the tool-owned import pointer. */
export async function syncPluginControl(
	options: Readonly<{ source: ControlMaterialSource; out: string; signal?: AbortSignal }>,
): Promise<ControlSyncResult> {
	checkAbort(options.signal)
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
	const selection = [...first.definitions]
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
		selection.push(...page.definitions)
		if (selection.length > 4096)
			throw failure('control_material_limit', 'The control definition index exceeds 4096 entries')
		offset = page.nextOffset
	}
	let total = first.materials.reduce((sum, item) => sum + item.manifestSize, 0)
	if (total > MAX_BYTES) throw failure('control_material_limit', 'Control manifests exceed 64 MiB')
	const materials = new Map<
		string,
		{ manifest: PluginControlManifest; files: Record<string, string> }
	>()
	for (const item of first.materials) {
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
	const exports = selection
		.sort((left, right) => compare(definitionKey(left.definition), definitionKey(right.definition)))
		.map((entry) => {
			const key = definitionKey(entry.definition)
			if (selected.has(key))
				throw failure(
					'control_contract_mismatch',
					'A committed Plugin definition appears more than once',
				)
			selected.add(key)
			const material = materials.get(entry.snapshot)
			const definition = material?.manifest.definitions.find(
				(item) => definitionKey(item.definition) === key && item.exportName === entry.exportName,
			)
			if (!definition)
				throw failure(
					'control_contract_mismatch',
					'The selected Plugin definition is absent from its material snapshot',
				)
			const entryKey = encodeControlData(entry.definition.entry)
			const digest = sha256(entryKey)
			if (entryKeys.has(digest) && entryKeys.get(digest) !== entryKey)
				throw failure(
					'control_contract_mismatch',
					'Canonical Plugin entries collide in the generated module layout',
				)
			entryKeys.set(digest, entryKey)
			const module = `entries/${digest}/index.mjs`
			let names = namesByModule.get(module)
			if (!names) namesByModule.set(module, (names = new Set()))
			const family = (name: string) => [
				name,
				...['ConfigDeclaration', 'ConfigInput', 'ConfigOutput', 'Instance'].map(
					(suffix) => `${name}${suffix}`,
				),
			]
			let exportName = entry.definition.exportName
			if (!isControlExportName(exportName) || family(exportName).some((name) => names.has(name)))
				exportName = `Plugin_${sha256(key)}`
			if (family(exportName).some((name) => names.has(name)))
				throw failure(
					'control_contract_mismatch',
					'Plugin control exports collide in one canonical entry',
				)
			for (const name of family(exportName)) names.add(name)
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
	for (const module of namesByModule.keys()) {
		const definitions = exports.filter((entry) => entry.module === module)
		files[module] = renderPluginDescriptors(
			definitions.map((entry) => ({
				exportName: entry.exportName,
				descriptor: { format: 2, definition: entry.definition, contracts: entry.contracts },
			})),
		)
		files[module.replace(/\.mjs$/, '.d.mts')] = definitions
			.map((entry) => {
				const path = JSON.stringify(
					`../../materials/${entry.snapshot.slice(7)}/${entry.originalModule}`,
				)
				return `export { ${entry.originalExport} as ${entry.exportName} } from ${path};\nexport type { ${['ConfigDeclaration', 'ConfigInput', 'ConfigOutput', 'Instance'].map((suffix) => `${entry.originalExport}${suffix} as ${entry.exportName}${suffix}`).join(', ')} } from ${path};\n`
			})
			.join('')
	}

	const unsigned = {
		format: 2 as const,
		compiler: '@pluxel/agent-sdk/control-sync/2',
		definitions: exports.map(({ definition, exportName, module, contracts, source }) => ({
			definition,
			exportName,
			module,
			contracts,
			source,
		})),
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
	const out = resolve(options.out)
	checkAbort(options.signal)
	// Publication settles atomically once started, including when the caller aborts.
	await installSnapshot(out, manifest.snapshot, files)
	return Object.freeze({
		out,
		snapshot: manifest.snapshot,
		catalogRevision: first.catalogRevision,
		unavailableCount: first.unavailableCount,
		definitions: Object.freeze(
			exports.map(({ definition, exportName, module }) =>
				Object.freeze({ definition, exportName, module: join(out, 'current', module) }),
			),
		),
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
