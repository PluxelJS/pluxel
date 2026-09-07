import {
	parsePluginDefinitionAddress,
	pluginDefinitionAddressEqual,
	type Context,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import {
	WorkbenchArtifactService,
	WORKBENCH_ARTIFACT_TRANSACTION,
	type WorkbenchArtifactCandidate,
	type WorkbenchArtifactRevision,
	type WorkbenchPreparedArtifactCandidate,
} from './WorkbenchArtifactService'
import {
	WorkbenchContentArtifactService,
	type WorkbenchContentArtifactCandidate,
	type WorkbenchContentArtifactRevision,
	type WorkbenchPreparedContentArtifactCandidate,
} from './WorkbenchContentArtifactService'

export type WorkbenchArtifactBatchCandidate = Readonly<{
	definition: PluginDefinitionAddress
	federation?: WorkbenchArtifactCandidate
	content?: WorkbenchContentArtifactCandidate
}>

export type WorkbenchArtifactBatchCommit = Readonly<{
	revision: number
	federation: WorkbenchArtifactRevision | null
	content: WorkbenchContentArtifactRevision | null
}>

type PreparedArtifactBatch = Readonly<{
	definition: PluginDefinitionAddress
	federation?: WorkbenchPreparedArtifactCandidate
	content?: WorkbenchPreparedContentArtifactCandidate
}>

const PREPARED_BATCH = Symbol('pluxel.workbench.prepared-artifact-batch')

/** @internal Validated complete tuple; only the coordinator can create and commit it. */
export type WorkbenchPreparedArtifactBatchCandidate = Readonly<{
	[PREPARED_BATCH]: PreparedArtifactBatch
}>

/**
 * Coordinates the two independent immutable stores at the definition-candidate boundary.
 * Validation is complete before either store mutates; a failed commit restores both checkpoints.
 */
export class WorkbenchArtifactCoordinator {
	private revisionValue = 0
	private readonly listeners = new Set<(commit: WorkbenchArtifactBatchCommit) => void>()

	constructor(
		private readonly root: Context,
		readonly federation: WorkbenchArtifactService,
		readonly content: WorkbenchContentArtifactService,
	) {
		federation.subscribe((commit) => {
			this.publish(
				Object.freeze({
					federation: commit.current,
					content: this.content.getCurrent(commit.current.definition) ?? null,
				}),
			)
		})
		content.subscribe((commit) => {
			this.publish(
				Object.freeze({
					federation: this.federation.getCurrent(commit.current.definition) ?? null,
					content: commit.current,
				}),
			)
		})
	}

	get revision(): number {
		return this.revisionValue
	}

	subscribe(listener: (commit: WorkbenchArtifactBatchCommit) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	async commitCandidate(
		candidate: WorkbenchArtifactBatchCandidate,
	): Promise<WorkbenchArtifactBatchCommit> {
		return this.commitPrepared(await this.prepareCandidate(candidate))
	}

	/** Validates both sides without mutating either current store. */
	async prepareCandidate(
		candidate: WorkbenchArtifactBatchCandidate,
	): Promise<WorkbenchPreparedArtifactBatchCandidate> {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
			throw new TypeError('[workbench] artifact candidate batch must be an object')
		}
		const keys = Object.keys(candidate).sort()
		if (keys.some((key) => !['definition', 'federation', 'content'].includes(key))) {
			throw new TypeError('[workbench] artifact candidate batch has unsupported fields')
		}
		const federationInput = optionalCandidateSide(candidate, 'federation')
		const contentInput = optionalCandidateSide(candidate, 'content')
		const definition = parsePluginDefinitionAddress(candidate.definition)
		if (
			(federationInput &&
				!pluginDefinitionAddressEqual(federationInput.plan.definition, definition)) ||
			(contentInput && !pluginDefinitionAddressEqual(contentInput.definition, definition))
		) {
			throw new TypeError('[workbench] artifact candidate batch definitions do not match')
		}

		const [federation, content] = await Promise.all([
			federationInput
				? this.federation.prepareCandidate(WORKBENCH_ARTIFACT_TRANSACTION, federationInput)
				: undefined,
			contentInput
				? this.content.prepareCandidate(WORKBENCH_ARTIFACT_TRANSACTION, contentInput)
				: undefined,
		])
		return Object.freeze({
			[PREPARED_BATCH]: Object.freeze({ definition, federation, content }),
		})
	}

	/** Commits one already validated tuple synchronously. */
	commitPrepared(candidate: WorkbenchPreparedArtifactBatchCandidate): WorkbenchArtifactBatchCommit {
		const { definition, federation, content } = readPreparedBatch(candidate)
		if (federation) this.federation.assertPrepared(WORKBENCH_ARTIFACT_TRANSACTION, federation)
		if (content) this.content.assertPrepared(WORKBENCH_ARTIFACT_TRANSACTION, content)
		const federationCheckpoint = federation
			? this.federation.checkpointPrepared(WORKBENCH_ARTIFACT_TRANSACTION, federation)
			: undefined
		const contentCheckpoint = content
			? this.content.checkpointPrepared(WORKBENCH_ARTIFACT_TRANSACTION, content)
			: undefined
		const federationCurrentCheckpoint = federation
			? undefined
			: this.federation.checkpointCurrent(WORKBENCH_ARTIFACT_TRANSACTION, definition)
		const contentCurrentCheckpoint = content
			? undefined
			: this.content.checkpointCurrent(WORKBENCH_ARTIFACT_TRANSACTION, definition)
		const previousFederationRevision = this.federation.revision
		const previousContentRevision = this.content.revision
		let committedFederation: WorkbenchArtifactRevision | null = null
		let committedContent: WorkbenchContentArtifactRevision | null = null
		try {
			if (federation) {
				committedFederation = this.federation.commitPrepared(
					WORKBENCH_ARTIFACT_TRANSACTION,
					federation,
					{ notify: false },
				)
			} else this.federation.withdrawCurrent(WORKBENCH_ARTIFACT_TRANSACTION, definition)
			if (content) {
				committedContent = this.content.commitPrepared(WORKBENCH_ARTIFACT_TRANSACTION, content, {
					notify: false,
				})
			} else this.content.withdrawCurrent(WORKBENCH_ARTIFACT_TRANSACTION, definition)
		} catch (error) {
			if (contentCheckpoint) {
				this.content.restoreCheckpoint(WORKBENCH_ARTIFACT_TRANSACTION, contentCheckpoint)
			}
			if (contentCurrentCheckpoint) {
				this.content.restoreCurrentCheckpoint(
					WORKBENCH_ARTIFACT_TRANSACTION,
					contentCurrentCheckpoint,
				)
			}
			if (federationCheckpoint) {
				this.federation.restoreCheckpoint(WORKBENCH_ARTIFACT_TRANSACTION, federationCheckpoint)
			}
			if (federationCurrentCheckpoint) {
				this.federation.restoreCurrentCheckpoint(
					WORKBENCH_ARTIFACT_TRANSACTION,
					federationCurrentCheckpoint,
				)
			}
			throw error
		}

		const changed =
			this.federation.revision !== previousFederationRevision ||
			this.content.revision !== previousContentRevision
		if (!changed) {
			return Object.freeze({
				revision: this.revisionValue,
				federation: committedFederation,
				content: committedContent,
			})
		}
		return this.publish(
			Object.freeze({
				federation: committedFederation,
				content: committedContent,
			}),
		)
	}

	private publish(
		input: Omit<WorkbenchArtifactBatchCommit, 'revision'>,
	): WorkbenchArtifactBatchCommit {
		this.revisionValue += 1
		const commit = Object.freeze({ revision: this.revisionValue, ...input })
		for (const listener of this.listeners) {
			try {
				listener(commit)
			} catch (error) {
				this.root.logger.error('workbench artifact transaction listener failed', { error })
			}
		}
		return commit
	}
}

function optionalCandidateSide<Key extends 'federation' | 'content'>(
	candidate: WorkbenchArtifactBatchCandidate,
	key: Key,
): NonNullable<WorkbenchArtifactBatchCandidate[Key]> | undefined {
	const value = candidate[key]
	if (value === undefined) return undefined
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`[workbench] artifact candidate batch ${key} must be an object`)
	}
	return value
}

function readPreparedBatch(
	candidate: WorkbenchPreparedArtifactBatchCandidate,
): PreparedArtifactBatch {
	const prepared = candidate?.[PREPARED_BATCH]
	if (!prepared) throw new TypeError('[workbench] invalid prepared artifact candidate batch')
	return prepared
}
