import { randomUUID } from 'node:crypto'
import type { Context } from '@pluxel/core'
import type { StandardSchema, WorkbenchLiveQueryResource } from '../../../workbench/contracts'
import type { WorkbenchLiveQueryBinding } from '../../../workbench/runtime'
import { databaseHandleOwnsTables, subscribeDatabaseHandle } from '../../DatabaseService'
import { WorkbenchEventsService, type SseChannel } from './WorkbenchEventsService'

export type LiveQuerySnapshot<Row = unknown> = Readonly<{
	generation: string
	revision: number
	rows: readonly Row[]
}>

export type LiveQueryPatch<
	Row = unknown,
	Key extends string | number = string | number,
> = Readonly<{
	generation: string
	fromRevision: number
	toRevision: number
	upserted: readonly Row[]
	removed: readonly Key[]
	order: readonly Key[]
}>

type Variant = {
	params: unknown
	generation: string
	revision: number
	rows: readonly any[]
	byKey: Map<string | number, any>
	running?: Promise<LiveQuerySnapshot>
	dirty: boolean
	listeners: Set<(event: LiveQuerySnapshot | LiveQueryPatch) => void>
	lastUsed: number
}

type RegisteredLiveQuery = {
	owner: Context
	contract: WorkbenchLiveQueryResource<any, any>
	binding: WorkbenchLiveQueryBinding<any, any>
	variants: Map<string, Variant>
	disposeInvalidation: () => void
}

const MAX_VARIANTS = 32
const MAX_ROWS = 10_000
const MAX_BYTES = 5 * 1024 * 1024

export class WorkbenchLiveQueryService {
	private readonly resources = new Map<string, RegisteredLiveQuery>()

	constructor(
		private readonly root: Context,
		private readonly events: WorkbenchEventsService,
	) {}

	registerResourceFor<Params, Row>(
		owner: Context,
		modelKey: string,
		contract: WorkbenchLiveQueryResource<Params, Row>,
		binding: WorkbenchLiveQueryBinding<Params, Row>,
	): () => void {
		const namespace = liveQueryNamespace(owner.pluginInfo.id, modelKey)
		if (!databaseHandleOwnsTables(binding.database, binding.dependsOn)) {
			throw new Error(
				`[workbench] liveQuery "${modelKey}" dependsOn tables outside its database definition`,
			)
		}
		const previous = this.resources.get(namespace)
		previous?.disposeInvalidation()
		const registered: RegisteredLiveQuery = {
			owner,
			contract,
			binding,
			variants: new Map(),
			disposeInvalidation: () => {},
		}
		registered.disposeInvalidation = subscribeDatabaseHandle(
			binding.database,
			binding.dependsOn,
			() => this.invalidate(registered),
		)
		this.resources.set(namespace, registered)
		const disposeEvents = this.events.registerResourceFor(owner, namespace, (channel) =>
			this.stream(registered, channel),
		)
		let active = true
		return () => {
			if (!active) return
			active = false
			disposeEvents()
			if (this.resources.get(namespace) !== registered) return
			this.resources.delete(namespace)
			registered.disposeInvalidation()
			registered.variants.clear()
		}
	}

	async loadFor(ownerId: string, modelKey: string, rawParams: unknown): Promise<LiveQuerySnapshot> {
		const resource = this.resources.get(liveQueryNamespace(ownerId, modelKey))
		if (!resource) throw new Error('[workbench] liveQuery resource is unavailable')
		const variant = await this.variant(resource, rawParams)
		return await this.rerun(resource, variant, true)
	}

	private async stream(resource: RegisteredLiveQuery, channel: SseChannel): Promise<() => void> {
		const raw = decodeParams(channel.query.get('params'))
		const variant = await this.variant(resource, raw)
		const emit = (event: LiveQuerySnapshot | LiveQueryPatch) => {
			channel.emit('generation' in event && 'rows' in event ? 'snapshot' : 'patch', event)
		}
		variant.listeners.add(emit)
		try {
			emit(await this.rerun(resource, variant, false))
		} catch (error) {
			channel.emit('error', serializeError(error))
		}
		return () => {
			variant.listeners.delete(emit)
			variant.lastUsed = Date.now()
		}
	}

	private async variant(resource: RegisteredLiveQuery, rawParams: unknown): Promise<Variant> {
		const params = resource.contract.params
			? await validateSchema(resource.contract.params, rawParams, 'liveQuery params')
			: undefined
		const key = stableParamsKey(params)
		let variant = resource.variants.get(key)
		if (variant) {
			variant.lastUsed = Date.now()
			return variant
		}
		this.evictIdle(resource)
		if (resource.variants.size >= MAX_VARIANTS) {
			throw new Error(`[workbench] liveQuery active variant limit exceeded (${MAX_VARIANTS})`)
		}
		variant = {
			params,
			generation: randomUUID(),
			revision: 0,
			rows: Object.freeze([]),
			byKey: new Map(),
			dirty: true,
			listeners: new Set(),
			lastUsed: Date.now(),
		}
		resource.variants.set(key, variant)
		return variant
	}

	private invalidate(resource: RegisteredLiveQuery): void {
		for (const variant of resource.variants.values()) {
			variant.dirty = true
			if (variant.listeners.size > 0) {
				void this.rerun(resource, variant, false).catch((error) => {
					resource.owner.logger.error('workbench liveQuery rerun failed', { error })
				})
			}
		}
	}

	private rerun(
		resource: RegisteredLiveQuery,
		variant: Variant,
		force: boolean,
	): Promise<LiveQuerySnapshot> {
		if (variant.running) {
			variant.dirty ||= force
			return variant.running
		}
		if (!force && !variant.dirty && variant.revision > 0) {
			return Promise.resolve(snapshotOf(variant))
		}
		variant.dirty = false
		variant.running = this.execute(resource, variant).finally(() => {
			variant.running = undefined
			if (variant.dirty && variant.listeners.size > 0) {
				void this.rerun(resource, variant, false).catch((error) => {
					resource.owner.logger.error('workbench liveQuery coalesced rerun failed', { error })
				})
			}
		})
		return variant.running
	}

	private async execute(
		resource: RegisteredLiveQuery,
		variant: Variant,
	): Promise<LiveQuerySnapshot> {
		const rawRows = await resource.binding.database.read((db) =>
			resource.binding.query(db as never, variant.params as never),
		)
		if (!Array.isArray(rawRows))
			throw new TypeError('[workbench] liveQuery query must return an array')
		if (rawRows.length > MAX_ROWS) {
			throw new Error(`[workbench] liveQuery row limit exceeded (${MAX_ROWS})`)
		}
		const rows: any[] = []
		const byKey = new Map<string | number, any>()
		for (const rawRow of rawRows) {
			const row = await validateSchema(resource.contract.row, rawRow, 'liveQuery row')
			const key = (row as any)?.[resource.contract.key]
			if (typeof key !== 'string' && (typeof key !== 'number' || !Number.isFinite(key))) {
				throw new Error(
					`[workbench] liveQuery key "${resource.contract.key}" must be string/number`,
				)
			}
			if (byKey.has(key)) throw new Error(`[workbench] liveQuery returned duplicate key "${key}"`)
			assertWireValue(row)
			rows.push(Object.freeze(cloneWire(row)))
			byKey.set(key, rows.at(-1))
		}
		const bytes = JSON.stringify(rows).length
		if (bytes > MAX_BYTES)
			throw new Error(`[workbench] liveQuery byte limit exceeded (${MAX_BYTES})`)

		const previousRevision = variant.revision
		const previousByKey = variant.byKey
		variant.revision++
		variant.rows = Object.freeze(rows)
		variant.byKey = byKey
		variant.lastUsed = Date.now()
		const snapshot = snapshotOf(variant)
		if (previousRevision === 0) return snapshot

		const upserted = rows.filter((row) => {
			const key = row[resource.contract.key]
			return JSON.stringify(previousByKey.get(key)) !== JSON.stringify(row)
		})
		const removed = [...previousByKey.keys()].filter((key) => !byKey.has(key))
		const patch: LiveQueryPatch = Object.freeze({
			generation: variant.generation,
			fromRevision: previousRevision,
			toRevision: variant.revision,
			upserted: Object.freeze(upserted),
			removed: Object.freeze(removed),
			order: Object.freeze(rows.map((row) => row[resource.contract.key])),
		})
		for (const listener of variant.listeners) listener(patch)
		return snapshot
	}

	private evictIdle(resource: RegisteredLiveQuery): void {
		const idle = [...resource.variants.entries()]
			.filter(([, variant]) => variant.listeners.size === 0 && !variant.running)
			.sort(([, left], [, right]) => left.lastUsed - right.lastUsed)
		while (resource.variants.size >= MAX_VARIANTS && idle.length > 0) {
			resource.variants.delete(idle.shift()![0])
		}
	}
}

export function liveQueryNamespace(ownerPluginId: string, modelKey: string): string {
	return `${ownerPluginId}:${modelKey}`
}

function snapshotOf(variant: Variant): LiveQuerySnapshot {
	return Object.freeze({
		generation: variant.generation,
		revision: variant.revision,
		rows: variant.rows,
	})
}

async function validateSchema<Output>(
	schema: StandardSchema<any, Output>,
	value: unknown,
	label: string,
): Promise<Output> {
	const result = await schema['~standard'].validate(value)
	if (result.issues) {
		throw new TypeError(`[workbench] invalid ${label}: ${JSON.stringify(result.issues)}`)
	}
	return result.value
}

function stableParamsKey(value: unknown): string {
	return JSON.stringify(sortWire(value)) ?? 'undefined'
}

function sortWire(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortWire)
	if (!value || typeof value !== 'object') return value
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, sortWire(child)]),
	)
}

function assertWireValue(value: unknown): void {
	const json = JSON.stringify(value)
	if (json === undefined) throw new TypeError('[workbench] liveQuery row is not JSON serializable')
	const parsed = JSON.parse(json)
	if (JSON.stringify(parsed) !== json) throw new TypeError('[workbench] invalid liveQuery wire row')
}

function cloneWire<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

function decodeParams(value: string | null): unknown {
	if (!value) return undefined
	try {
		return JSON.parse(value)
	} catch {
		throw new TypeError('[workbench] invalid liveQuery params JSON')
	}
}

function serializeError(error: unknown): { message: string } {
	return { message: error instanceof Error ? error.message : String(error) }
}
