import {
	parsePluginDefinitionAddress,
	pluginDefinitionAddressEqual,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
} from '@pluxel/core'

export type WorkbenchProducerBuildIdentity = Readonly<{
	definition: PluginDefinitionAddress
	producer: string
	buildRevision: string
}>

export type WorkbenchProducerStatus =
	| (WorkbenchProducerBuildIdentity & Readonly<{ state: 'building' }>)
	| (WorkbenchProducerBuildIdentity & Readonly<{ state: 'failed'; message: string }>)

export type WorkbenchProducerStatusLookup = Pick<
	WorkbenchProducerStatusService,
	'getStatus' | 'pendingProducerBuildsEnabled' | 'subscribe'
>

export type WorkbenchProducerStatusReporter = Pick<
	WorkbenchProducerStatusService,
	| 'enablePendingProducerBuilds'
	| 'disablePendingProducerBuilds'
	| 'setBuilding'
	| 'setFailed'
	| 'clear'
	| 'clearAll'
>

type StoredProducerStatus = Readonly<{
	definition: PluginDefinitionAddress
	status: WorkbenchProducerStatus
}>

const PRODUCER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const BUILD_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_STATUS_MESSAGE_LENGTH = 2048

/**
 * Tracks development-only Workbench producer availability without mutating the immutable
 * artifact inventory. A missing producer is publishable only when a development compiler has
 * enabled pending builds and recorded a concrete status for that definition.
 */
export class WorkbenchProducerStatusService {
	private revisionValue = 0
	private pendingProducerBuilds = false
	private readonly currentByDefinition = new Map<string, StoredProducerStatus>()
	private readonly listeners = new Set<(revision: number) => void>()

	get revision(): number {
		return this.revisionValue
	}

	get pendingProducerBuildsEnabled(): boolean {
		return this.pendingProducerBuilds
	}

	subscribe(listener: (revision: number) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getStatus(definition: PluginDefinitionAddress): WorkbenchProducerStatus | undefined {
		const canonical = parsePluginDefinitionAddress(definition)
		const stored = this.currentByDefinition.get(pluginDefinitionIndexKey(canonical))
		if (!stored || !pluginDefinitionAddressEqual(stored.definition, canonical)) return undefined
		return stored.status
	}

	enablePendingProducerBuilds(): void {
		if (this.pendingProducerBuilds) return
		this.pendingProducerBuilds = true
		this.bump()
	}

	disablePendingProducerBuilds(): void {
		const changed = this.pendingProducerBuilds || this.currentByDefinition.size > 0
		this.pendingProducerBuilds = false
		this.currentByDefinition.clear()
		if (changed) this.bump()
	}

	setBuilding(input: WorkbenchProducerBuildIdentity): void {
		this.setStatus(Object.freeze({ ...readIdentity(input), state: 'building' as const }))
	}

	setFailed(input: WorkbenchProducerBuildIdentity & Readonly<{ error: unknown }>): void {
		this.setStatus(
			Object.freeze({
				...readIdentity(input),
				state: 'failed' as const,
				message: producerErrorMessage(input.error),
			}),
		)
	}

	clear(definition: PluginDefinitionAddress): void {
		const canonical = parsePluginDefinitionAddress(definition)
		if (!this.currentByDefinition.delete(pluginDefinitionIndexKey(canonical))) return
		this.bump()
	}

	clearAll(): void {
		if (this.currentByDefinition.size === 0) return
		this.currentByDefinition.clear()
		this.bump()
	}

	private setStatus(status: WorkbenchProducerStatus): void {
		const key = pluginDefinitionIndexKey(status.definition)
		const current = this.currentByDefinition.get(key)
		if (current && sameStatus(current.status, status)) return
		this.currentByDefinition.set(
			key,
			Object.freeze({
				definition: status.definition,
				status,
			}),
		)
		this.bump()
	}

	private bump(): void {
		this.revisionValue += 1
		for (const listener of this.listeners) listener(this.revisionValue)
	}
}

function readIdentity(input: WorkbenchProducerBuildIdentity): WorkbenchProducerBuildIdentity {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('[workbench] producer status input must be an object')
	}
	const definition = parsePluginDefinitionAddress(input.definition)
	if (typeof input.producer !== 'string' || !PRODUCER.test(input.producer)) {
		throw new TypeError('[workbench] producer status producer is invalid')
	}
	if (typeof input.buildRevision !== 'string' || !BUILD_REVISION.test(input.buildRevision)) {
		throw new TypeError('[workbench] producer status buildRevision is invalid')
	}
	return Object.freeze({
		definition,
		producer: input.producer,
		buildRevision: input.buildRevision,
	})
}

function sameStatus(left: WorkbenchProducerStatus, right: WorkbenchProducerStatus): boolean {
	return (
		left.state === right.state &&
		left.producer === right.producer &&
		left.buildRevision === right.buildRevision &&
		pluginDefinitionAddressEqual(left.definition, right.definition) &&
		(left.state !== 'failed' || right.state !== 'failed' || left.message === right.message)
	)
}

function producerErrorMessage(error: unknown): string {
	let message = ''
	if (error instanceof Error) message = error.message
	else if (typeof error === 'string') message = error
	const line = message
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find(Boolean)
	const value = line || 'Workbench producer build failed'
	return value.length > MAX_STATUS_MESSAGE_LENGTH
		? `${value.slice(0, MAX_STATUS_MESSAGE_LENGTH - 3)}...`
		: value
}
