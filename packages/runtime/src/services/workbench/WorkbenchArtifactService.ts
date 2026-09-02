import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import {
	pluginDefinitionAddressEqual,
	pluginDefinitionIndexKey,
	type Context,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import {
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	WORKBENCH_PROFILE_VERSION,
	assertWorkbenchFederationSnapshotContract,
	createWorkbenchFederationCompatibilitySet,
	createWorkbenchFederationProducerPlan,
	parseWorkbenchDeclarationIdentity,
	parseWorkbenchFederationManifestContract,
	workbenchDeclarationIdentityEqual,
	type WorkbenchDeclarationIdentity,
	type WorkbenchFederationProducerPlan,
	type WorkbenchFederationTypeAssetPolicy,
} from '@pluxel/core/federation'
import { generateSnapshotFromManifest, type Manifest } from '@module-federation/sdk'
import { extname, isAbsolute, join, relative, resolve } from 'pathe'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import { version as runtimeVersion } from '../../../package.json'
import { runtimeWorkbenchFederationArtifactPath } from '../../web/paths'

export type WorkbenchArtifactCandidate = Readonly<{
	plan: WorkbenchFederationProducerPlan
	artifactRoot: string
	/** @defaultValue 'required' */
	typeAssets?: WorkbenchFederationTypeAssetPolicy
}>

export type WorkbenchArtifactEntry = Readonly<{
	descriptor: WorkbenchDeclarationIdentity
	expose: `./views/${string}`
}>

/**
 * An immutable, validated MF producer revision.
 *
 * The standard Manifest remains the browser artifact authority. This record only pins
 * the Plugin definition/build identity and exact Bridge expose inventory needed by the
 * Workbench publication and layout planes.
 */
export type WorkbenchArtifactRevision = Readonly<{
	profile: typeof WORKBENCH_PROFILE_VERSION
	definition: PluginDefinitionAddress
	producer: string
	buildRevision: string
	manifestUrl: string
	manifestSha256: string
	entries: readonly WorkbenchArtifactEntry[]
}>

export type WorkbenchResolvedArtifactEntry = Readonly<{
	artifact: WorkbenchArtifactRevision
	entry: WorkbenchArtifactEntry
}>

export type WorkbenchArtifactFile = Readonly<{
	body: Uint8Array
	contentType: string
	etag: string
}>

export type WorkbenchArtifactCommit = Readonly<{
	revision: number
	current: WorkbenchArtifactRevision
	previous: WorkbenchArtifactRevision | null
}>

/** Narrow Registry dependency. It intentionally exposes no compiler/store lifecycle. */
export type WorkbenchArtifactLookup = Pick<WorkbenchArtifactService, 'resolveEntry'>

type StoredFile = Readonly<{
	path: string
	sha256: string
	size: number
	contentType: string
	manifestBytes?: Uint8Array
}>

type StoredRevision = Readonly<{
	value: WorkbenchArtifactRevision
	definitionKey: string
	fingerprint: string
	entriesByKey: ReadonlyMap<string, WorkbenchArtifactEntry>
	files: ReadonlyMap<string, StoredFile>
}>

const PREPARED = Symbol('pluxel.workbench.prepared-federation-artifact')

/** @internal Package-private authority for the combined artifact transaction. */
export const WORKBENCH_ARTIFACT_TRANSACTION = Symbol('pluxel.workbench.artifact-transaction')

/** @internal Validated immutable candidate; only its owning store can commit it. */
export type WorkbenchPreparedArtifactCandidate = Readonly<{
	[PREPARED]: StoredRevision
}>

const CHECKPOINT = Symbol('pluxel.workbench.federation-artifact-checkpoint')

/** @internal Rollback token used only by the combined Workbench artifact transaction. */
export type WorkbenchArtifactCheckpoint = Readonly<{
	[CHECKPOINT]: Readonly<{
		definitionKey: string
		reference: string
		current?: StoredRevision
		revision?: StoredRevision
		revisionValue: number
	}>
}>

const CURRENT_CHECKPOINT = Symbol('pluxel.workbench.federation-current-checkpoint')

/** @internal Current-pointer rollback token for an absent artifact in a full batch. */
export type WorkbenchArtifactCurrentCheckpoint = Readonly<{
	[CURRENT_CHECKPOINT]: Readonly<{
		definitionKey: string
		current?: StoredRevision
		revisionValue: number
	}>
}>

const SHA256 = /^[a-f\d]{64}$/
const PROFILE_COMPATIBILITY = createWorkbenchFederationCompatibilitySet({
	react: React.version,
	reactDom: ReactDom.version,
	runtime: runtimeVersion,
})

/**
 * Definition-scoped immutable MF artifact inventory.
 *
 * Candidate validation completes before either inventory map is mutated. A committed
 * revision is addressable only by its exact producer/buildRevision tuple; current
 * definition lookup never acts as fallback for a pinned read.
 */
export class WorkbenchArtifactService {
	private revisionValue = 0
	private readonly currentByDefinition = new Map<string, StoredRevision>()
	private readonly revisionsByReference = new Map<string, StoredRevision>()
	private readonly listeners = new Set<(commit: WorkbenchArtifactCommit) => void>()

	constructor(private readonly root: Context) {}

	get revision(): number {
		return this.revisionValue
	}

	subscribe(listener: (commit: WorkbenchArtifactCommit) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getCurrent(definition: PluginDefinitionAddress): WorkbenchArtifactRevision | undefined {
		return this.currentByDefinition.get(pluginDefinitionIndexKey(definition))?.value
	}

	getPinned(producer: string, buildRevision: string): WorkbenchArtifactRevision | undefined {
		return this.revisionsByReference.get(referenceKey(producer, buildRevision))?.value
	}

	resolveEntry(
		definition: PluginDefinitionAddress,
		descriptor: WorkbenchDeclarationIdentity,
	): WorkbenchResolvedArtifactEntry | undefined {
		const canonicalDescriptor = parseWorkbenchDeclarationIdentity(descriptor)
		if (!pluginDefinitionAddressEqual(canonicalDescriptor.owner, definition)) return undefined
		const stored = this.currentByDefinition.get(pluginDefinitionIndexKey(definition))
		const entry = stored?.entriesByKey.get(descriptorKey(canonicalDescriptor))
		if (
			!stored ||
			!entry ||
			!workbenchDeclarationIdentityEqual(entry.descriptor, canonicalDescriptor)
		) {
			return undefined
		}
		return Object.freeze({ artifact: stored.value, entry })
	}

	async prepareCandidate(
		authority: symbol,
		candidate: WorkbenchArtifactCandidate,
	): Promise<WorkbenchPreparedArtifactCandidate> {
		assertTransactionAuthority(authority)
		return Object.freeze({ [PREPARED]: await prepareCandidate(candidate) })
	}

	assertPrepared(authority: symbol, candidate: WorkbenchPreparedArtifactCandidate): void {
		assertTransactionAuthority(authority)
		const prepared = readPrepared(candidate)
		const reference = referenceKey(prepared.value.producer, prepared.value.buildRevision)
		const existing = this.revisionsByReference.get(reference)
		if (existing) {
			if (existing.fingerprint !== prepared.fingerprint) {
				throw new Error(
					`[workbench] immutable federation revision collision: ${prepared.value.producer}@${prepared.value.buildRevision}`,
				)
			}
		}
	}

	checkpointPrepared(
		authority: symbol,
		candidate: WorkbenchPreparedArtifactCandidate,
	): WorkbenchArtifactCheckpoint {
		assertTransactionAuthority(authority)
		const stored = readPrepared(candidate)
		const reference = referenceKey(stored.value.producer, stored.value.buildRevision)
		return Object.freeze({
			[CHECKPOINT]: Object.freeze({
				definitionKey: stored.definitionKey,
				reference,
				current: this.currentByDefinition.get(stored.definitionKey),
				revision: this.revisionsByReference.get(reference),
				revisionValue: this.revisionValue,
			}),
		})
	}

	restoreCheckpoint(authority: symbol, checkpoint: WorkbenchArtifactCheckpoint): void {
		assertTransactionAuthority(authority)
		const state = checkpoint?.[CHECKPOINT]
		if (!state) throw new TypeError('[workbench] invalid federation artifact checkpoint')
		if (state.current) this.currentByDefinition.set(state.definitionKey, state.current)
		else this.currentByDefinition.delete(state.definitionKey)
		if (state.revision) this.revisionsByReference.set(state.reference, state.revision)
		else this.revisionsByReference.delete(state.reference)
		this.revisionValue = state.revisionValue
	}

	checkpointCurrent(
		authority: symbol,
		definition: PluginDefinitionAddress,
	): WorkbenchArtifactCurrentCheckpoint {
		assertTransactionAuthority(authority)
		const definitionKey = pluginDefinitionIndexKey(definition)
		return Object.freeze({
			[CURRENT_CHECKPOINT]: Object.freeze({
				definitionKey,
				current: this.currentByDefinition.get(definitionKey),
				revisionValue: this.revisionValue,
			}),
		})
	}

	restoreCurrentCheckpoint(
		authority: symbol,
		checkpoint: WorkbenchArtifactCurrentCheckpoint,
	): void {
		assertTransactionAuthority(authority)
		const state = checkpoint?.[CURRENT_CHECKPOINT]
		if (!state) throw new TypeError('[workbench] invalid federation current checkpoint')
		if (state.current) this.currentByDefinition.set(state.definitionKey, state.current)
		else this.currentByDefinition.delete(state.definitionKey)
		this.revisionValue = state.revisionValue
	}

	withdrawCurrent(
		authority: symbol,
		definition: PluginDefinitionAddress,
	): WorkbenchArtifactRevision | null {
		assertTransactionAuthority(authority)
		const definitionKey = pluginDefinitionIndexKey(definition)
		const previous = this.currentByDefinition.get(definitionKey)
		if (!previous) return null
		this.currentByDefinition.delete(definitionKey)
		this.revisionValue += 1
		return previous.value
	}

	commitPrepared(
		authority: symbol,
		candidate: WorkbenchPreparedArtifactCandidate,
		options: Readonly<{ notify?: boolean }> = {},
	): WorkbenchArtifactRevision {
		assertTransactionAuthority(authority)
		const prepared = readPrepared(candidate)
		this.assertPrepared(authority, candidate)
		const reference = referenceKey(prepared.value.producer, prepared.value.buildRevision)
		const stored = this.revisionsByReference.get(reference) ?? prepared
		this.revisionsByReference.set(reference, stored)
		return this.commit(stored, options.notify !== false)
	}

	/**
	 * Reads one file from an exact committed revision and verifies its immutable digest.
	 * Unknown revisions/files return `null`; the current definition revision is never used
	 * as a fallback. The Manifest bytes are returned exactly as emitted by MF.
	 */
	async readArtifactFile(
		producer: string,
		buildRevision: string,
		file: string,
	): Promise<WorkbenchArtifactFile | null> {
		const normalized = normalizeArtifactPath(file)
		if (!normalized) return null
		const stored = this.revisionsByReference.get(referenceKey(producer, buildRevision))
		const expected = stored?.files.get(normalized)
		if (!stored || !expected) return null

		const body = expected.manifestBytes
			? Buffer.from(expected.manifestBytes)
			: await readFile(expected.path).catch((): null => null)
		if (!body || body.byteLength !== expected.size || sha256(body) !== expected.sha256) {
			throw new Error(
				`[workbench] committed federation artifact changed: ${producer}@${buildRevision}/${normalized}`,
			)
		}
		return Object.freeze({
			body,
			contentType: expected.contentType,
			etag: `"sha256-${expected.sha256}"`,
		})
	}

	private commit(stored: StoredRevision, notify: boolean): WorkbenchArtifactRevision {
		const previous = this.currentByDefinition.get(stored.definitionKey)
		if (previous === stored) return stored.value
		this.currentByDefinition.set(stored.definitionKey, stored)
		this.revisionValue += 1
		if (notify) {
			const commit = Object.freeze({
				revision: this.revisionValue,
				current: stored.value,
				previous: previous?.value ?? null,
			})
			for (const listener of this.listeners) {
				try {
					listener(commit)
				} catch (error) {
					this.root.logger.error('workbench artifact commit listener failed', { error })
				}
			}
		}
		return stored.value
	}
}

function readPrepared(candidate: WorkbenchPreparedArtifactCandidate): StoredRevision {
	const stored = candidate?.[PREPARED]
	if (!stored) throw new TypeError('[workbench] invalid prepared federation artifact candidate')
	return stored
}

function assertTransactionAuthority(authority: symbol): void {
	if (authority !== WORKBENCH_ARTIFACT_TRANSACTION) {
		throw new TypeError('[workbench] artifact store mutation requires coordinator authority')
	}
}

async function prepareCandidate(candidate: WorkbenchArtifactCandidate): Promise<StoredRevision> {
	const plan = canonicalPlan(candidate?.plan)
	const artifactRoot = await canonicalDirectory(candidate?.artifactRoot)
	const manifestPath = resolve(artifactRoot, WORKBENCH_FEDERATION_MANIFEST_FILE)
	const manifestBytes = await readFile(manifestPath).catch((error) => {
		throw new Error(
			`[workbench] federation candidate has no ${WORKBENCH_FEDERATION_MANIFEST_FILE}`,
			{ cause: error },
		)
	})
	let manifest: Manifest
	let manifestFiles: readonly string[]
	try {
		const input = JSON.parse(Buffer.from(manifestBytes).toString('utf-8')) as unknown
		manifestFiles = parseWorkbenchFederationManifestContract(input, {
			plan,
			compatibility: PROFILE_COMPATIBILITY,
			typeAssets: candidate.typeAssets ?? 'required',
		}).files
		manifest = input as Manifest
	} catch (error) {
		throw new TypeError(
			`[workbench] federation manifest contract is invalid: ${errorMessage(error)}`,
			{ cause: error },
		)
	}
	try {
		const snapshot = generateSnapshotFromManifest(manifest, { version: plan.buildRevision })
		assertWorkbenchFederationSnapshotContract(snapshot, plan)
	} catch (error) {
		throw new TypeError(
			`[workbench] federation manifest cannot produce the required Snapshot: ${errorMessage(error)}`,
			{ cause: error },
		)
	}
	const artifactFiles = await collectArtifactFiles(artifactRoot)
	const files = new Map<string, StoredFile>()
	for (const file of [...new Set([...manifestFiles, ...artifactFiles])].sort()) {
		const filePath = await canonicalArtifactFile(artifactRoot, file)
		const bytes =
			file === WORKBENCH_FEDERATION_MANIFEST_FILE ? manifestBytes : await readFile(filePath)
		files.set(
			file,
			Object.freeze({
				path: filePath,
				sha256: sha256(bytes),
				size: bytes.byteLength,
				contentType: contentTypeForFile(file),
				...(file === WORKBENCH_FEDERATION_MANIFEST_FILE
					? { manifestBytes: Uint8Array.from(bytes) }
					: {}),
			}),
		)
	}

	const entries = Object.freeze(
		plan.entries.map((entry) =>
			Object.freeze({ descriptor: entry.descriptor, expose: entry.expose }),
		),
	)
	const entriesByKey = new Map(
		entries.map((entry) => [descriptorKey(entry.descriptor), entry] as const),
	)
	const manifestSha256 = files.get(WORKBENCH_FEDERATION_MANIFEST_FILE)!.sha256
	const value: WorkbenchArtifactRevision = Object.freeze({
		profile: WORKBENCH_PROFILE_VERSION,
		definition: plan.definition,
		producer: plan.producer,
		buildRevision: plan.buildRevision,
		manifestUrl: runtimeWorkbenchFederationArtifactPath(
			plan.producer,
			plan.buildRevision,
			WORKBENCH_FEDERATION_MANIFEST_FILE,
		),
		manifestSha256,
		entries,
	})
	const fingerprint = sha256(
		Buffer.from(
			[
				pluginDefinitionIndexKey(plan.definition),
				plan.producer,
				plan.buildRevision,
				...entries.map(
					(entry) => `${entry.descriptor.kind}:${entry.descriptor.key}:${entry.expose}`,
				),
				...[...files.entries()]
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([file, storedFile]) => `${file}:${storedFile.sha256}`),
			].join('\n'),
		),
	)
	return Object.freeze({
		value,
		definitionKey: pluginDefinitionIndexKey(plan.definition),
		fingerprint,
		entriesByKey,
		files,
	})
}

function canonicalPlan(input: WorkbenchFederationProducerPlan): WorkbenchFederationProducerPlan {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('[workbench] federation candidate plan must be an object')
	}
	const keys = Object.keys(input).sort()
	if (
		keys.length !== 5 ||
		keys.some(
			(key, index) =>
				key !== ['buildRevision', 'definition', 'entries', 'producer', 'profile'][index],
		)
	) {
		throw new TypeError('[workbench] federation candidate plan has invalid fields')
	}
	if (!Array.isArray(input.entries)) {
		throw new TypeError('[workbench] federation candidate entries must be an array')
	}
	const canonical = createWorkbenchFederationProducerPlan({
		definition: input.definition,
		buildRevision: input.buildRevision,
		entries: input.entries.map((entry) => ({
			descriptor: entry.descriptor,
			bridgeEntryPath: entry.bridgeEntryPath,
		})),
	})
	if (
		input.profile !== canonical.profile ||
		input.producer !== canonical.producer ||
		input.buildRevision !== canonical.buildRevision ||
		!pluginDefinitionAddressEqual(input.definition, canonical.definition) ||
		input.entries.length !== canonical.entries.length ||
		input.entries.some((entry, index) => {
			const expected = canonical.entries[index]
			return (
				!expected ||
				entry.expose !== expected.expose ||
				entry.bridgeEntryPath !== expected.bridgeEntryPath ||
				!workbenchDeclarationIdentityEqual(entry.descriptor, expected.descriptor)
			)
		})
	) {
		throw new TypeError('[workbench] federation candidate plan is not canonical')
	}
	return canonical
}

async function canonicalDirectory(input: unknown): Promise<string> {
	if (typeof input !== 'string' || !isAbsolute(input)) {
		throw new TypeError('[workbench] federation artifactRoot must be an absolute path')
	}
	const root = await realpath(input).catch((error) => {
		throw new Error('[workbench] federation artifactRoot does not exist', { cause: error })
	})
	const rootStat = await stat(root)
	if (!rootStat.isDirectory()) {
		throw new TypeError('[workbench] federation artifactRoot must be a directory')
	}
	return root
}

async function canonicalArtifactFile(root: string, file: string): Promise<string> {
	const normalized = normalizeArtifactPath(file)
	if (!normalized) throw new TypeError(`[workbench] invalid federation artifact path: ${file}`)
	const path = await realpath(join(root, normalized)).catch((error) => {
		throw new Error(`[workbench] federation artifact is missing: ${normalized}`, {
			cause: error,
		})
	})
	const fromRoot = relative(root, path)
	if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
		throw new TypeError(`[workbench] federation artifact escapes its root: ${normalized}`)
	}
	const fileStat = await stat(path)
	if (!fileStat.isFile()) {
		throw new TypeError(`[workbench] federation artifact is not a file: ${normalized}`)
	}
	return path
}

async function collectArtifactFiles(root: string): Promise<readonly string[]> {
	const files: string[] = []
	const visit = async (directory: string, prefix: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true })
		entries.sort((left, right) => left.name.localeCompare(right.name))
		for (const entry of entries) {
			const file = prefix ? `${prefix}/${entry.name}` : entry.name
			if (normalizeArtifactPath(file) !== file) {
				throw new TypeError(`[workbench] invalid federation artifact path: ${file}`)
			}
			const path = join(directory, entry.name)
			if (entry.isDirectory()) {
				await visit(path, file)
				continue
			}
			if (!entry.isFile()) {
				throw new TypeError(`[workbench] federation artifact must be a regular file: ${file}`)
			}
			files.push(file)
		}
	}
	await visit(root, '')
	return Object.freeze(files)
}

function normalizeArtifactPath(input: unknown): string | null {
	if (
		typeof input !== 'string' ||
		!input ||
		input.startsWith('/') ||
		input.includes('\\') ||
		input.includes('\0') ||
		input.includes('?') ||
		input.includes('#') ||
		/^[A-Za-z][A-Za-z\d+.-]*:/.test(input)
	) {
		return null
	}
	const value = input.startsWith('./') ? input.slice(2) : input
	const segments = value.split('/')
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
	return segments.join('/')
}

function descriptorKey(descriptor: WorkbenchDeclarationIdentity): string {
	return `${descriptor.kind}\0${descriptor.key}`
}

function referenceKey(producer: string, buildRevision: string): string {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(producer) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(buildRevision)
	) {
		return ''
	}
	return `${producer}\0${buildRevision}`
}

function sha256(input: Uint8Array): string {
	const value = createHash('sha256').update(input).digest('hex')
	if (!SHA256.test(value)) throw new Error('unreachable SHA-256 state')
	return value
}

function contentTypeForFile(path: string): string {
	switch (extname(path).toLowerCase()) {
		case '.js':
		case '.mjs':
			return 'application/javascript; charset=utf-8'
		case '.css':
			return 'text/css; charset=utf-8'
		case '.json':
		case '.map':
			return 'application/json; charset=utf-8'
		case '.svg':
			return 'image/svg+xml'
		case '.png':
			return 'image/png'
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg'
		case '.woff':
			return 'font/woff'
		case '.woff2':
			return 'font/woff2'
		case '.zip':
			return 'application/zip'
		default:
			return 'application/octet-stream'
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
