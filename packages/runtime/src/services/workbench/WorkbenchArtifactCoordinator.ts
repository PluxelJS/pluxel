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
	WorkbenchPageArtifactService,
	type WorkbenchPageArtifactCandidate,
	type WorkbenchPageArtifactRevision,
	type WorkbenchPreparedPageArtifactCandidate,
} from './WorkbenchPageArtifactService'

export type WorkbenchArtifactBatchCandidate = Readonly<{
	definition: PluginDefinitionAddress
	federation?: WorkbenchArtifactCandidate
	pages?: WorkbenchPageArtifactCandidate
}>

export type WorkbenchArtifactBatchCommit = Readonly<{
	revision: number
	federation: WorkbenchArtifactRevision | null
	pages: WorkbenchPageArtifactRevision | null
}>

type PreparedArtifactBatch = Readonly<{
	definition: PluginDefinitionAddress
	federation?: WorkbenchPreparedArtifactCandidate
	pages?: WorkbenchPreparedPageArtifactCandidate
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
		readonly pages: WorkbenchPageArtifactService,
	) {
		federation.subscribe((commit) => {
			this.publish(
				Object.freeze({
					federation: commit.current,
					pages: this.pages.getCurrent(commit.current.definition) ?? null,
				}),
			)
		})
		pages.subscribe((commit) => {
			this.publish(
				Object.freeze({
					federation: this.federation.getCurrent(commit.current.definition) ?? null,
					pages: commit.current,
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
		if (keys.some((key) => !['definition', 'federation', 'pages'].includes(key))) {
			throw new TypeError('[workbench] artifact candidate batch has unsupported fields')
		}
		const federationInput = optionalCandidateSide(candidate, 'federation')
		const pageInput = optionalCandidateSide(candidate, 'pages')
		const definition = parsePluginDefinitionAddress(candidate.definition)
		if (
			(federationInput &&
				!pluginDefinitionAddressEqual(federationInput.plan.definition, definition)) ||
			(pageInput && !pluginDefinitionAddressEqual(pageInput.definition, definition))
		) {
			throw new TypeError('[workbench] artifact candidate batch definitions do not match')
		}

		const [federation, pages] = await Promise.all([
			federationInput
				? this.federation.prepareCandidate(WORKBENCH_ARTIFACT_TRANSACTION, federationInput)
				: undefined,
			pageInput
				? this.pages.prepareCandidate(WORKBENCH_ARTIFACT_TRANSACTION, pageInput)
				: undefined,
		])
		return Object.freeze({
			[PREPARED_BATCH]: Object.freeze({ definition, federation, pages }),
		})
	}

	/** Commits one already validated tuple synchronously. */
	commitPrepared(candidate: WorkbenchPreparedArtifactBatchCandidate): WorkbenchArtifactBatchCommit {
		const { definition, federation, pages } = readPreparedBatch(candidate)
		if (federation) this.federation.assertPrepared(WORKBENCH_ARTIFACT_TRANSACTION, federation)
		if (pages) this.pages.assertPrepared(WORKBENCH_ARTIFACT_TRANSACTION, pages)
		const federationCheckpoint = federation
			? this.federation.checkpointPrepared(WORKBENCH_ARTIFACT_TRANSACTION, federation)
			: undefined
		const pageCheckpoint = pages
			? this.pages.checkpointPrepared(WORKBENCH_ARTIFACT_TRANSACTION, pages)
			: undefined
		const federationCurrentCheckpoint = federation
			? undefined
			: this.federation.checkpointCurrent(WORKBENCH_ARTIFACT_TRANSACTION, definition)
		const pageCurrentCheckpoint = pages
			? undefined
			: this.pages.checkpointCurrent(WORKBENCH_ARTIFACT_TRANSACTION, definition)
		const previousFederationRevision = this.federation.revision
		const previousPageRevision = this.pages.revision
		let committedFederation: WorkbenchArtifactRevision | null = null
		let committedPages: WorkbenchPageArtifactRevision | null = null
		try {
			if (federation) {
				committedFederation = this.federation.commitPrepared(
					WORKBENCH_ARTIFACT_TRANSACTION,
					federation,
					{ notify: false },
				)
			} else this.federation.withdrawCurrent(WORKBENCH_ARTIFACT_TRANSACTION, definition)
			if (pages) {
				committedPages = this.pages.commitPrepared(WORKBENCH_ARTIFACT_TRANSACTION, pages, {
					notify: false,
				})
			} else this.pages.withdrawCurrent(WORKBENCH_ARTIFACT_TRANSACTION, definition)
		} catch (error) {
			if (pageCheckpoint) {
				this.pages.restoreCheckpoint(WORKBENCH_ARTIFACT_TRANSACTION, pageCheckpoint)
			}
			if (pageCurrentCheckpoint) {
				this.pages.restoreCurrentCheckpoint(WORKBENCH_ARTIFACT_TRANSACTION, pageCurrentCheckpoint)
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
			this.pages.revision !== previousPageRevision
		if (!changed) {
			return Object.freeze({
				revision: this.revisionValue,
				federation: committedFederation,
				pages: committedPages,
			})
		}
		return this.publish(
			Object.freeze({
				federation: committedFederation,
				pages: committedPages,
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

function optionalCandidateSide<Key extends 'federation' | 'pages'>(
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
