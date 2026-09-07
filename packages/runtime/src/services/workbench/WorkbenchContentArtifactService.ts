import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import {
	pluginDefinitionAddressEqual,
	pluginDefinitionIndexKey,
	type Context,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import {
	WORKBENCH_CONTENT_ARTIFACT_FILE,
	parseWorkbenchContentSet,
	serializeWorkbenchContentDefinition,
	serializeWorkbenchContentSet,
	type WorkbenchContentSet,
	type WorkbenchContentPlan,
} from '@pluxel/core/internal'
import {
	parseWorkbenchOpenableIdentity,
	workbenchOpenableIdentityEqual,
	type WorkbenchContentIdentity,
} from '@pluxel/core/federation'
import { isAbsolute, join, relative } from 'pathe'
import type { WorkbenchMarkdownDocument } from '../../workbench/definition'
import { WORKBENCH_ARTIFACT_TRANSACTION } from './WorkbenchArtifactService'

export type WorkbenchContentArtifactCandidate = Readonly<{
	definition: PluginDefinitionAddress
	definitionDigest: string
	digest: string
	artifactRoot: string
}>

export type WorkbenchContentArtifactEntry = Readonly<{
	descriptor: WorkbenchContentIdentity
}>

export type WorkbenchContentArtifactRevision = Readonly<{
	profile: 1
	definition: PluginDefinitionAddress
	definitionDigest: string
	digest: string
	entries: readonly WorkbenchContentArtifactEntry[]
}>

export type WorkbenchResolvedContentArtifact = Readonly<{
	artifact: WorkbenchContentArtifactRevision
	entry: WorkbenchContentArtifactEntry
	plan: WorkbenchContentPlan
}>

export type WorkbenchContentArtifactCommit = Readonly<{
	revision: number
	current: WorkbenchContentArtifactRevision
	previous: WorkbenchContentArtifactRevision | null
}>

export type WorkbenchContentArtifactLookup = Readonly<{
	resolveContent(
		definition: PluginDefinitionAddress,
		descriptor: WorkbenchContentIdentity,
		/** Test lookups may synthesize a plan from the current declaration. */
		declaration?: WorkbenchMarkdownDocument,
	): WorkbenchResolvedContentArtifact | undefined
}>

type StoredContentEntry = Readonly<{
	value: WorkbenchContentArtifactEntry
	plan: WorkbenchContentPlan
}>

type StoredContentRevision = Readonly<{
	value: WorkbenchContentArtifactRevision
	definitionKey: string
	referenceKey: string
	entriesByKey: ReadonlyMap<string, StoredContentEntry>
}>

const PREPARED = Symbol('pluxel.workbench.prepared-content-artifact')

/** @internal Validated immutable candidate; only its owning store can commit it. */
export type WorkbenchPreparedContentArtifactCandidate = Readonly<{
	[PREPARED]: StoredContentRevision
}>

const CHECKPOINT = Symbol('pluxel.workbench.content-artifact-checkpoint')

/** @internal Rollback token used only by the combined Workbench artifact transaction. */
export type WorkbenchContentArtifactCheckpoint = Readonly<{
	[CHECKPOINT]: Readonly<{
		definitionKey: string
		referenceKey: string
		current?: StoredContentRevision
		revision?: StoredContentRevision
		revisionValue: number
	}>
}>

const CURRENT_CHECKPOINT = Symbol('pluxel.workbench.content-current-checkpoint')

/** @internal Current-pointer rollback token for an absent artifact in a full batch. */
export type WorkbenchContentArtifactCurrentCheckpoint = Readonly<{
	[CURRENT_CHECKPOINT]: Readonly<{
		definitionKey: string
		current?: StoredContentRevision
		revisionValue: number
	}>
}>

const SHA256 = /^[a-f\d]{64}$/
const MAX_CONTENT_ARTIFACT_BYTES = 512 * 1_024 + 1

/** Definition-scoped immutable Workbench Content artifact inventory. */
export class WorkbenchContentArtifactService {
	private revisionValue = 0
	private readonly currentByDefinition = new Map<string, StoredContentRevision>()
	private readonly revisionsByReference = new Map<string, StoredContentRevision>()
	private readonly listeners = new Set<(commit: WorkbenchContentArtifactCommit) => void>()

	constructor(private readonly root: Context) {}

	get revision(): number {
		return this.revisionValue
	}

	subscribe(listener: (commit: WorkbenchContentArtifactCommit) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getCurrent(definition: PluginDefinitionAddress): WorkbenchContentArtifactRevision | undefined {
		return this.currentByDefinition.get(pluginDefinitionIndexKey(definition))?.value
	}

	getPinned(
		definitionDigest: string,
		contentDigest: string,
	): WorkbenchContentArtifactRevision | undefined {
		return this.revisionsByReference.get(referenceKey(definitionDigest, contentDigest))?.value
	}

	resolveContent(
		definition: PluginDefinitionAddress,
		descriptor: WorkbenchContentIdentity,
	): WorkbenchResolvedContentArtifact | undefined {
		const canonical = parseWorkbenchOpenableIdentity(descriptor)
		if (
			canonical.kind !== 'content' ||
			!pluginDefinitionAddressEqual(canonical.owner, definition)
		) {
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
		candidate: WorkbenchContentArtifactCandidate,
	): Promise<WorkbenchPreparedContentArtifactCandidate> {
		assertTransactionAuthority(authority)
		return Object.freeze({ [PREPARED]: await prepareCandidate(candidate) })
	}

	assertPrepared(authority: symbol, candidate: WorkbenchPreparedContentArtifactCandidate): void {
		assertTransactionAuthority(authority)
		const stored = readPrepared(candidate)
		const existing = this.revisionsByReference.get(stored.referenceKey)
		if (existing && !sameContentRevision(existing, stored)) {
			throw new Error(
				`[workbench] immutable Content revision collision: ${stored.value.definitionDigest}@${stored.value.digest}`,
			)
		}
	}

	checkpointPrepared(
		authority: symbol,
		candidate: WorkbenchPreparedContentArtifactCandidate,
	): WorkbenchContentArtifactCheckpoint {
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

	restoreCheckpoint(authority: symbol, checkpoint: WorkbenchContentArtifactCheckpoint): void {
		assertTransactionAuthority(authority)
		const state = checkpoint?.[CHECKPOINT]
		if (!state) throw new TypeError('[workbench] invalid Content artifact checkpoint')
		if (state.current) this.currentByDefinition.set(state.definitionKey, state.current)
		else this.currentByDefinition.delete(state.definitionKey)
		if (state.revision) this.revisionsByReference.set(state.referenceKey, state.revision)
		else this.revisionsByReference.delete(state.referenceKey)
		this.revisionValue = state.revisionValue
	}

	checkpointCurrent(
		authority: symbol,
		definition: PluginDefinitionAddress,
	): WorkbenchContentArtifactCurrentCheckpoint {
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
		checkpoint: WorkbenchContentArtifactCurrentCheckpoint,
	): void {
		assertTransactionAuthority(authority)
		const state = checkpoint?.[CURRENT_CHECKPOINT]
		if (!state) throw new TypeError('[workbench] invalid Content current checkpoint')
		if (state.current) this.currentByDefinition.set(state.definitionKey, state.current)
		else this.currentByDefinition.delete(state.definitionKey)
		this.revisionValue = state.revisionValue
	}

	withdrawCurrent(
		authority: symbol,
		definition: PluginDefinitionAddress,
	): WorkbenchContentArtifactRevision | null {
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
		candidate: WorkbenchPreparedContentArtifactCandidate,
		options: Readonly<{ notify?: boolean }> = {},
	): WorkbenchContentArtifactRevision {
		assertTransactionAuthority(authority)
		const prepared = readPrepared(candidate)
		this.assertPrepared(authority, candidate)
		const stored = this.revisionsByReference.get(prepared.referenceKey) ?? prepared
		this.revisionsByReference.set(stored.referenceKey, stored)
		return this.commit(stored, options.notify !== false)
	}

	private commit(stored: StoredContentRevision, notify: boolean): WorkbenchContentArtifactRevision {
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
					this.root.logger.error('workbench Content artifact commit listener failed', { error })
				}
			}
		}
		return stored.value
	}
}

async function prepareCandidate(
	candidate: WorkbenchContentArtifactCandidate,
): Promise<StoredContentRevision> {
	const definition = candidate?.definition
	const definitionKey = pluginDefinitionIndexKey(definition)
	const definitionDigest = digest(candidate?.definitionDigest, 'definition digest')
	const expectedDefinitionDigest = sha256(
		Buffer.from(serializeWorkbenchContentDefinition(definition), 'utf-8'),
	)
	if (definitionDigest !== expectedDefinitionDigest) {
		throw new TypeError('[workbench] Content candidate definition digest is not canonical')
	}
	const contentDigest = digest(candidate?.digest, 'Content set digest')
	const artifactRoot = await canonicalDirectory(candidate?.artifactRoot)
	const artifactPath = await canonicalArtifactFile(artifactRoot)
	const bytes = await readArtifactFile(artifactPath)
	if (sha256(bytes) !== contentDigest) {
		throw new TypeError('[workbench] Content candidate digest does not match its artifact bytes')
	}
	let serialized: string
	try {
		serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch (error) {
		throw new TypeError('[workbench] Content candidate artifact is not valid UTF-8', {
			cause: error,
		})
	}
	let contentSet: WorkbenchContentSet
	try {
		contentSet = parseWorkbenchContentSet(JSON.parse(serialized) as unknown)
	} catch (error) {
		throw new TypeError('[workbench] Content candidate artifact is invalid', { cause: error })
	}
	if (serializeWorkbenchContentSet(contentSet) !== serialized) {
		throw new TypeError('[workbench] Content candidate artifact is not canonically serialized')
	}
	if (!pluginDefinitionAddressEqual(contentSet.definition, definition)) {
		throw new TypeError('[workbench] Content candidate definition does not match its Content set')
	}
	const storedEntries = contentSet.entries.map((entry) => {
		const descriptor = parseWorkbenchOpenableIdentity({
			kind: 'content',
			owner: definition,
			key: entry.key,
		})
		if (descriptor.kind !== 'content')
			throw new Error('unreachable Workbench Content identity state')
		return Object.freeze({
			value: Object.freeze({ descriptor }),
			plan: entry.content,
		})
	})
	const entriesByKey = new Map(
		storedEntries.map((entry) => [entry.value.descriptor.key, entry] as const),
	)
	const value = Object.freeze({
		profile: 1 as const,
		definition,
		definitionDigest,
		digest: contentDigest,
		entries: Object.freeze(storedEntries.map((entry) => entry.value)),
	})
	return Object.freeze({
		value,
		definitionKey,
		referenceKey: referenceKey(definitionDigest, contentDigest),
		entriesByKey,
	})
}

function readPrepared(candidate: WorkbenchPreparedContentArtifactCandidate): StoredContentRevision {
	const stored = candidate?.[PREPARED]
	if (!stored) throw new TypeError('[workbench] invalid prepared Content artifact candidate')
	return stored
}

function assertTransactionAuthority(authority: symbol): void {
	if (authority !== WORKBENCH_ARTIFACT_TRANSACTION) {
		throw new TypeError('[workbench] artifact store mutation requires coordinator authority')
	}
}

function sameContentRevision(left: StoredContentRevision, right: StoredContentRevision): boolean {
	return (
		left.definitionKey === right.definitionKey &&
		left.value.definitionDigest === right.value.definitionDigest &&
		left.value.digest === right.value.digest
	)
}

async function canonicalDirectory(input: unknown): Promise<string> {
	if (typeof input !== 'string' || !isAbsolute(input)) {
		throw new TypeError('[workbench] Content artifactRoot must be an absolute path')
	}
	const root = await realpath(input).catch((error) => {
		throw new Error('[workbench] Content artifactRoot does not exist', { cause: error })
	})
	const rootStat = await stat(root)
	if (!rootStat.isDirectory()) {
		throw new TypeError('[workbench] Content artifactRoot must be a directory')
	}
	return root
}

async function canonicalArtifactFile(root: string): Promise<string> {
	const path = await realpath(join(root, WORKBENCH_CONTENT_ARTIFACT_FILE)).catch((error) => {
		throw new Error(`[workbench] Content artifact is missing: ${WORKBENCH_CONTENT_ARTIFACT_FILE}`, {
			cause: error,
		})
	})
	const fromRoot = relative(root, path)
	if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
		throw new TypeError('[workbench] Content artifact escapes its root')
	}
	return path
}

async function readArtifactFile(path: string): Promise<Buffer> {
	const file = await open(path, 'r')
	try {
		const fileStat = await file.stat()
		if (!fileStat.isFile()) throw new TypeError('[workbench] Content artifact is not a file')
		if (fileStat.size > MAX_CONTENT_ARTIFACT_BYTES) {
			throw new TypeError('[workbench] Content artifact exceeds the serialized byte budget')
		}
		const buffer = Buffer.allocUnsafe(MAX_CONTENT_ARTIFACT_BYTES + 1)
		let bytesRead = 0
		while (bytesRead < buffer.byteLength) {
			const result = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead)
			if (result.bytesRead === 0) break
			bytesRead += result.bytesRead
		}
		if (bytesRead > MAX_CONTENT_ARTIFACT_BYTES) {
			throw new TypeError('[workbench] Content artifact exceeds the serialized byte budget')
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

function referenceKey(definitionDigest: string, contentDigest: string): string {
	return `${digest(definitionDigest, 'definition digest')}\0${digest(contentDigest, 'Content set digest')}`
}

function sha256(input: Uint8Array): string {
	return createHash('sha256').update(input).digest('hex')
}
