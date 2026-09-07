import type { ConcretePluginDefinitionCandidate } from '../definition'
import type { PluginDefinitionAddress, PluginNodeAddress } from '../identity'

const DEFAULT_RUNTIME_UPDATE_REASON: RuntimeUpdateReason = 'runtime-update'
const CLOSED_MESSAGE = 'Core Plugin update transaction is already closed'
const PREPARED_MESSAGE = 'Core Plugin update transaction is already prepared'

export type CascadeOptions = { cascadeDependents?: boolean }
export type ReplaceDefinitionOptions = CascadeOptions
export type RuntimeUpdateReason = string
export type RuntimeUpdateOptions = { reason?: RuntimeUpdateReason }
export type RuntimeUpdateCommitMeta = { reason: RuntimeUpdateReason }
export type PreparedRuntimeUpdateCommitOptions = Readonly<{
	/** Runs synchronously and exactly once when the prepared Core graph becomes committed fact. */
	onGraphCommitted?: () => void
}>

export interface PreparedRuntimeUpdate<TCommitResult = unknown> {
	readonly reason: RuntimeUpdateReason
	commit(options?: PreparedRuntimeUpdateCommitOptions): Promise<TCommitResult>
	rollback(): void
}

export interface RuntimeUpdateTransaction<TCommitResult = unknown> {
	readonly reason: RuntimeUpdateReason
	materializeNode(address: PluginNodeAddress, candidate: ConcretePluginDefinitionCandidate): void
	dematerializeNode(address: PluginNodeAddress, options?: CascadeOptions): void
	restartNode(address: PluginNodeAddress, options?: CascadeOptions): void
	replaceDefinition(
		address: PluginDefinitionAddress,
		candidate: ConcretePluginDefinitionCandidate,
		options?: ReplaceDefinitionOptions,
	): void
	setProviderDefault(token: PluginDefinitionAddress, provider: PluginNodeAddress | null): void
	setDependencyOverride(
		consumer: PluginNodeAddress,
		requirement: PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): void
	prepare(): PreparedRuntimeUpdate<TCommitResult>
	commit(options?: PreparedRuntimeUpdateCommitOptions): Promise<TCommitResult>
	rollback(): void
}

export type RuntimeUpdateController<TCommitResult> = {
	materializeNode(address: PluginNodeAddress, candidate: ConcretePluginDefinitionCandidate): void
	dematerializeNode(address: PluginNodeAddress, options?: CascadeOptions): void
	restartNode(address: PluginNodeAddress, options?: CascadeOptions): void
	replaceDefinition(
		address: PluginDefinitionAddress,
		candidate: ConcretePluginDefinitionCandidate,
		options?: ReplaceDefinitionOptions,
	): void
	setProviderDefault(token: PluginDefinitionAddress, provider: PluginNodeAddress | null): void
	setDependencyOverride(
		consumer: PluginNodeAddress,
		requirement: PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): void
	prepareDraft(
		tx: RuntimeUpdateTransaction<TCommitResult>,
		meta: RuntimeUpdateCommitMeta,
	): PreparedRuntimeUpdate<TCommitResult>
	rollbackDraft(tx: RuntimeUpdateTransaction<TCommitResult>): void
}

export class PluginRuntimeUpdateTransaction<
	TCommitResult,
> implements RuntimeUpdateTransaction<TCommitResult> {
	readonly reason: RuntimeUpdateReason
	private state: 'open' | 'prepared' | 'closed' = 'open'
	private prepared?: PreparedRuntimeUpdate<TCommitResult>

	constructor(
		private readonly controller: RuntimeUpdateController<TCommitResult>,
		options: RuntimeUpdateOptions = {},
	) {
		this.reason = options.reason ?? DEFAULT_RUNTIME_UPDATE_REASON
	}

	materializeNode(address: PluginNodeAddress, candidate: ConcretePluginDefinitionCandidate): void {
		this.assertOpen()
		this.controller.materializeNode(address, candidate)
	}

	dematerializeNode(address: PluginNodeAddress, options?: CascadeOptions): void {
		this.assertOpen()
		this.controller.dematerializeNode(address, options)
	}

	restartNode(address: PluginNodeAddress, options?: CascadeOptions): void {
		this.assertOpen()
		this.controller.restartNode(address, options)
	}

	replaceDefinition(
		address: PluginDefinitionAddress,
		candidate: ConcretePluginDefinitionCandidate,
		options?: ReplaceDefinitionOptions,
	): void {
		this.assertOpen()
		this.controller.replaceDefinition(address, candidate, options)
	}

	setProviderDefault(token: PluginDefinitionAddress, provider: PluginNodeAddress | null): void {
		this.assertOpen()
		this.controller.setProviderDefault(token, provider)
	}

	setDependencyOverride(
		consumer: PluginNodeAddress,
		requirement: PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): void {
		this.assertOpen()
		this.controller.setDependencyOverride(consumer, requirement, provider)
	}

	prepare(): PreparedRuntimeUpdate<TCommitResult> {
		if (this.state === 'prepared') return this.prepared!
		this.assertOpen()
		const prepared = this.controller.prepareDraft(this, { reason: this.reason })
		this.prepared = prepared
		this.state = 'prepared'
		return prepared
	}

	commit(options?: PreparedRuntimeUpdateCommitOptions): Promise<TCommitResult> {
		return this.prepare().commit(options)
	}

	rollback(): void {
		if (this.state === 'closed') return
		if (this.state === 'prepared') {
			this.prepared!.rollback()
			this.state = 'closed'
			return
		}
		this.state = 'closed'
		this.controller.rollbackDraft(this)
	}

	/** @internal Called by the prepared handle after logical commit. */
	markCommitted(): void {
		this.state = 'closed'
	}

	private assertOpen(): void {
		if (this.state === 'closed') throw new Error(CLOSED_MESSAGE)
		if (this.state === 'prepared') throw new Error(PREPARED_MESSAGE)
	}
}
