import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import {
	pluginDefinitionAddressEqual,
	pluginDefinitionIndexKey,
	type Context,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import {
	WORKBENCH_PAGE_ARTIFACT_FILE,
	parseWorkbenchPageSet,
	serializeWorkbenchPageDefinition,
	serializeWorkbenchPageSet,
	type WorkbenchPageSetV1,
	type WorkbenchStandardPagePlanV1,
} from '@pluxel/core/internal'
import {
	parseWorkbenchOpenableIdentity,
	workbenchOpenableIdentityEqual,
	type WorkbenchPageIdentity,
} from '@pluxel/core/federation'
import { isAbsolute, join, relative } from 'pathe'
import { WORKBENCH_ARTIFACT_TRANSACTION } from './WorkbenchArtifactService'

export type WorkbenchPageArtifactCandidate = Readonly<{
	definition: PluginDefinitionAddress
	definitionDigest: string
	digest: string
	artifactRoot: string
}>

export type WorkbenchPageArtifactEntry = Readonly<{
	descriptor: WorkbenchPageIdentity
}>

export type WorkbenchPageArtifactRevision = Readonly<{
	profile: 1
	definition: PluginDefinitionAddress
	definitionDigest: string
	digest: string
	entries: readonly WorkbenchPageArtifactEntry[]
}>

export type WorkbenchResolvedPageArtifact = Readonly<{
	artifact: WorkbenchPageArtifactRevision
	entry: WorkbenchPageArtifactEntry
	plan: WorkbenchStandardPagePlanV1
}>

export type WorkbenchPageArtifactCommit = Readonly<{
	revision: number
	current: WorkbenchPageArtifactRevision
	previous: WorkbenchPageArtifactRevision | null
}>

export type WorkbenchPageArtifactLookup = Pick<WorkbenchPageArtifactService, 'resolvePage'>

type StoredPageEntry = Readonly<{
	value: WorkbenchPageArtifactEntry
	plan: WorkbenchStandardPagePlanV1
}>

type StoredPageRevision = Readonly<{
	value: WorkbenchPageArtifactRevision
	definitionKey: string
	referenceKey: string
	entriesByKey: ReadonlyMap<string, StoredPageEntry>
}>

const PREPARED = Symbol('pluxel.workbench.prepared-page-artifact')

/** @internal Validated immutable candidate; only its owning store can commit it. */
export type WorkbenchPreparedPageArtifactCandidate = Readonly<{
	[PREPARED]: StoredPageRevision
}>

const CHECKPOINT = Symbol('pluxel.workbench.page-artifact-checkpoint')

/** @internal Rollback token used only by the combined Workbench artifact transaction. */
export type WorkbenchPageArtifactCheckpoint = Readonly<{
	[CHECKPOINT]: Readonly<{
		definitionKey: string
		referenceKey: string
		current?: StoredPageRevision
		revision?: StoredPageRevision
		revisionValue: number
	}>
}>

const CURRENT_CHECKPOINT = Symbol('pluxel.workbench.page-current-checkpoint')

/** @internal Current-pointer rollback token for an absent artifact in a full batch. */
export type WorkbenchPageArtifactCurrentCheckpoint = Readonly<{
	[CURRENT_CHECKPOINT]: Readonly<{
		definitionKey: string
		current?: StoredPageRevision
		revisionValue: number
	}>
}>

const SHA256 = /^[a-f\d]{64}$/
const MAX_PAGE_ARTIFACT_BYTES = 512 * 1_024 + 1

/** Definition-scoped immutable Standard Page artifact inventory. */
export class WorkbenchPageArtifactService {
	private revisionValue = 0
	private readonly currentByDefinition = new Map<string, StoredPageRevision>()
	private readonly revisionsByReference = new Map<string, StoredPageRevision>()
	private readonly listeners = new Set<(commit: WorkbenchPageArtifactCommit) => void>()

	constructor(private readonly root: Context) {}

	get revision(): number {
		return this.revisionValue
	}

	subscribe(listener: (commit: WorkbenchPageArtifactCommit) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getCurrent(definition: PluginDefinitionAddress): WorkbenchPageArtifactRevision | undefined {
		return this.currentByDefinition.get(pluginDefinitionIndexKey(definition))?.value
	}

	getPinned(
		definitionDigest: string,
		pageDigest: string,
	): WorkbenchPageArtifactRevision | undefined {
		return this.revisionsByReference.get(referenceKey(definitionDigest, pageDigest))?.value
	}

	resolvePage(
		definition: PluginDefinitionAddress,
		descriptor: WorkbenchPageIdentity,
	): WorkbenchResolvedPageArtifact | undefined {
		const canonical = parseWorkbenchOpenableIdentity(descriptor)
		if (canonical.kind !== 'page' || !pluginDefinitionAddressEqual(canonical.owner, definition)) {
			return undefined
		}
		const stored = this.currentByDefinition.get(pluginDefinitionIndexKey(definition))
		const entry = stored?.entriesByKey.get(canonical.key)
		if (!stored || !entry || !workbenchOpenableIdentityEqual(entry.value.descriptor, canonical)) {
			return undefined
		}
		return Object.freeze({ artifact: stored.value, entry: entry.value, plan: entry.plan })
	}

	async prepareCandidate(
		authority: symbol,
		candidate: WorkbenchPageArtifactCandidate,
	): Promise<WorkbenchPreparedPageArtifactCandidate> {
		assertTransactionAuthority(authority)
		return Object.freeze({ [PREPARED]: await prepareCandidate(candidate) })
	}

	assertPrepared(authority: symbol, candidate: WorkbenchPreparedPageArtifactCandidate): void {
		assertTransactionAuthority(authority)
		const stored = readPrepared(candidate)
		const existing = this.revisionsByReference.get(stored.referenceKey)
		if (existing && !samePageRevision(existing, stored)) {
			throw new Error(
				`[workbench] immutable Page revision collision: ${stored.value.definitionDigest}@${stored.value.digest}`,
			)
		}
	}

	checkpointPrepared(
		authority: symbol,
		candidate: WorkbenchPreparedPageArtifactCandidate,
	): WorkbenchPageArtifactCheckpoint {
		assertTransactionAuthority(authority)
		const stored = readPrepared(candidate)
		return Object.freeze({
			[CHECKPOINT]: Object.freeze({
				definitionKey: stored.definitionKey,
				referenceKey: stored.referenceKey,
				current: this.currentByDefinition.get(stored.definitionKey),
				revision: this.revisionsByReference.get(stored.referenceKey),
				revisionValue: this.revisionValue,
			}),
		})
	}

	restoreCheckpoint(authority: symbol, checkpoint: WorkbenchPageArtifactCheckpoint): void {
		assertTransactionAuthority(authority)
		const state = checkpoint?.[CHECKPOINT]
		if (!state) throw new TypeError('[workbench] invalid Page artifact checkpoint')
		if (state.current) this.currentByDefinition.set(state.definitionKey, state.current)
		else this.currentByDefinition.delete(state.definitionKey)
		if (state.revision) this.revisionsByReference.set(state.referenceKey, state.revision)
		else this.revisionsByReference.delete(state.referenceKey)
		this.revisionValue = state.revisionValue
	}

	checkpointCurrent(
		authority: symbol,
		definition: PluginDefinitionAddress,
	): WorkbenchPageArtifactCurrentCheckpoint {
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
		checkpoint: WorkbenchPageArtifactCurrentCheckpoint,
	): void {
		assertTransactionAuthority(authority)
		const state = checkpoint?.[CURRENT_CHECKPOINT]
		if (!state) throw new TypeError('[workbench] invalid Page current checkpoint')
		if (state.current) this.currentByDefinition.set(state.definitionKey, state.current)
		else this.currentByDefinition.delete(state.definitionKey)
		this.revisionValue = state.revisionValue
	}

	withdrawCurrent(
		authority: symbol,
		definition: PluginDefinitionAddress,
	): WorkbenchPageArtifactRevision | null {
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
		candidate: WorkbenchPreparedPageArtifactCandidate,
		options: Readonly<{ notify?: boolean }> = {},
	): WorkbenchPageArtifactRevision {
		assertTransactionAuthority(authority)
		const prepared = readPrepared(candidate)
		this.assertPrepared(authority, candidate)
		const stored = this.revisionsByReference.get(prepared.referenceKey) ?? prepared
		this.revisionsByReference.set(stored.referenceKey, stored)
		return this.commit(stored, options.notify !== false)
	}

	private commit(stored: StoredPageRevision, notify: boolean): WorkbenchPageArtifactRevision {
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
					this.root.logger.error('workbench Page artifact commit listener failed', { error })
				}
			}
		}
		return stored.value
	}
}

async function prepareCandidate(
	candidate: WorkbenchPageArtifactCandidate,
): Promise<StoredPageRevision> {
	const definition = candidate?.definition
	const definitionKey = pluginDefinitionIndexKey(definition)
	const definitionDigest = digest(candidate?.definitionDigest, 'definition digest')
	const expectedDefinitionDigest = sha256(
		Buffer.from(serializeWorkbenchPageDefinition(definition), 'utf-8'),
	)
	if (definitionDigest !== expectedDefinitionDigest) {
		throw new TypeError('[workbench] Page candidate definition digest is not canonical')
	}
	const pageDigest = digest(candidate?.digest, 'Page set digest')
	const artifactRoot = await canonicalDirectory(candidate?.artifactRoot)
	const artifactPath = await canonicalArtifactFile(artifactRoot)
	const bytes = await readArtifactFile(artifactPath)
	if (sha256(bytes) !== pageDigest) {
		throw new TypeError('[workbench] Page candidate digest does not match its artifact bytes')
	}
	let serialized: string
	try {
		serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch (error) {
		throw new TypeError('[workbench] Page candidate artifact is not valid UTF-8', { cause: error })
	}
	let pageSet: WorkbenchPageSetV1
	try {
		pageSet = parseWorkbenchPageSet(JSON.parse(serialized) as unknown)
	} catch (error) {
		throw new TypeError('[workbench] Page candidate artifact is invalid', { cause: error })
	}
	if (serializeWorkbenchPageSet(pageSet) !== serialized) {
		throw new TypeError('[workbench] Page candidate artifact is not canonically serialized')
	}
	if (!pluginDefinitionAddressEqual(pageSet.definition, definition)) {
		throw new TypeError('[workbench] Page candidate definition does not match its Page set')
	}
	const storedEntries = pageSet.entries.map((entry) => {
		const descriptor = parseWorkbenchOpenableIdentity({
			kind: 'page',
			owner: definition,
			key: entry.key,
		})
		if (descriptor.kind !== 'page') throw new Error('unreachable Workbench Page identity state')
		return Object.freeze({
			value: Object.freeze({ descriptor }),
			plan: entry.page,
		})
	})
	const entriesByKey = new Map(
		storedEntries.map((entry) => [entry.value.descriptor.key, entry] as const),
	)
	const value = Object.freeze({
		profile: 1 as const,
		definition,
		definitionDigest,
		digest: pageDigest,
		entries: Object.freeze(storedEntries.map((entry) => entry.value)),
	})
	return Object.freeze({
		value,
		definitionKey,
		referenceKey: referenceKey(definitionDigest, pageDigest),
		entriesByKey,
	})
}

function readPrepared(candidate: WorkbenchPreparedPageArtifactCandidate): StoredPageRevision {
	const stored = candidate?.[PREPARED]
	if (!stored) throw new TypeError('[workbench] invalid prepared Page artifact candidate')
	return stored
}

function assertTransactionAuthority(authority: symbol): void {
	if (authority !== WORKBENCH_ARTIFACT_TRANSACTION) {
		throw new TypeError('[workbench] artifact store mutation requires coordinator authority')
	}
}

function samePageRevision(left: StoredPageRevision, right: StoredPageRevision): boolean {
	return (
		left.definitionKey === right.definitionKey &&
		left.value.definitionDigest === right.value.definitionDigest &&
		left.value.digest === right.value.digest
	)
}

async function canonicalDirectory(input: unknown): Promise<string> {
	if (typeof input !== 'string' || !isAbsolute(input)) {
		throw new TypeError('[workbench] Page artifactRoot must be an absolute path')
	}
	const root = await realpath(input).catch((error) => {
		throw new Error('[workbench] Page artifactRoot does not exist', { cause: error })
	})
	const rootStat = await stat(root)
	if (!rootStat.isDirectory()) {
		throw new TypeError('[workbench] Page artifactRoot must be a directory')
	}
	return root
}

async function canonicalArtifactFile(root: string): Promise<string> {
	const path = await realpath(join(root, WORKBENCH_PAGE_ARTIFACT_FILE)).catch((error) => {
		throw new Error(`[workbench] Page artifact is missing: ${WORKBENCH_PAGE_ARTIFACT_FILE}`, {
			cause: error,
		})
	})
	const fromRoot = relative(root, path)
	if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
		throw new TypeError('[workbench] Page artifact escapes its root')
	}
	return path
}

async function readArtifactFile(path: string): Promise<Buffer> {
	const file = await open(path, 'r')
	try {
		const fileStat = await file.stat()
		if (!fileStat.isFile()) throw new TypeError('[workbench] Page artifact is not a file')
		if (fileStat.size > MAX_PAGE_ARTIFACT_BYTES) {
			throw new TypeError('[workbench] Page artifact exceeds the serialized byte budget')
		}
		const buffer = Buffer.allocUnsafe(MAX_PAGE_ARTIFACT_BYTES + 1)
		let bytesRead = 0
		while (bytesRead < buffer.byteLength) {
			const result = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead)
			if (result.bytesRead === 0) break
			bytesRead += result.bytesRead
		}
		if (bytesRead > MAX_PAGE_ARTIFACT_BYTES) {
			throw new TypeError('[workbench] Page artifact exceeds the serialized byte budget')
		}
		return buffer.subarray(0, bytesRead)
	} finally {
		await file.close()
	}
}

function digest(input: unknown, label: string): string {
	if (typeof input !== 'string' || !SHA256.test(input)) {
		throw new TypeError(`[workbench] ${label} is invalid`)
	}
	return input
}

function referenceKey(definitionDigest: string, pageDigest: string): string {
	return `${digest(definitionDigest, 'definition digest')}\0${digest(pageDigest, 'Page set digest')}`
}

function sha256(input: Uint8Array): string {
	return createHash('sha256').update(input).digest('hex')
}
