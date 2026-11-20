import {
	parsePluginDefinitionAddress,
	parsePluginEntryAddress,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import { hash } from 'ohash'
import {
	hostPluginCatalogEntriesFromView,
	hostPluginStatusesFromView,
	type HostPluginStatusProjectionView,
	type HostPluginStatusSnapshot,
	type HostPluginCatalogEntry,
} from '../status'
import type { HostPluginGraphCommittedView } from '../coordinator'
import { ScriptError, type ScriptOperationError } from './sdk-outcomes'

/** Query input is captured at list() invocation. Both identity filters may be combined. */
export interface ScriptPluginListOptions {
	readonly packageName?: string
	readonly definition?: PluginDefinitionAddress
	/** Default 50; maximum 200. */
	readonly limit?: number
	/** Continue the same query on this Host. No resources or execution authority are retained. */
	readonly cursor?: string
}

/** One bounded committed discovery page. Each page observes current state. */
export type ScriptPluginSnapshot = Readonly<{
	nodes: readonly HostPluginStatusSnapshot[]
	catalogRevision: number
	runtimeStateRevision: number
	/** Null when this query has no more nodes. A stale cursor requires restarting at page one. */
	nextCursor: string | null
}>

export type ScriptPluginListError =
	| ScriptOperationError
	| Readonly<{ code: 'cursor_stale'; message: string }>

/** @internal Applied membership is stable; Core adjacency arrays are rebuilt on every read. */
export type ScriptPluginDiscoveryView = HostPluginStatusProjectionView &
	Readonly<{
		runtimeStateRevision: number
		appliedNodes: HostPluginGraphCommittedView['applied']['nodes']
	}>

type Inventory = Readonly<{
	catalog: ScriptPluginDiscoveryView['catalog']
	state: ScriptPluginDiscoveryView['state']
	sessionIntents: ScriptPluginDiscoveryView['sessionIntents']
	desiredControl: ScriptPluginDiscoveryView['desiredControl']
	appliedNodes: ScriptPluginDiscoveryView['appliedNodes']
	runtimeStateRevision: number
	queryKey: string
	entries: readonly HostPluginCatalogEntry[]
	signature: string
}>

// Each coordinator retains at most its last query's identity inventory. Status, diagnostics,
// and recent updates are always projected from the current committed read.
const owners = new WeakMap<object, { id: string; inventory?: Inventory }>()

/** @internal Called under the original coordinator's committed-read boundary. */
export function scriptPluginList(
	owner: object,
	view: ScriptPluginDiscoveryView,
	query: ReturnType<typeof captureScriptPluginListOptions> = captureScriptPluginListOptions(),
): ScriptPluginSnapshot {
	const cursor = query.cursor === undefined ? undefined : parseCursor(query.cursor)
	let state = owners.get(owner)
	if (!state) {
		state = { id: crypto.randomUUID() }
		owners.set(owner, state)
	}
	const queryKey = JSON.stringify([
		query.packageName ?? null,
		query.definition ? pluginDefinitionIndexKey(query.definition) : null,
	])
	let inventory = state.inventory
	if (
		!inventory ||
		inventory.catalog !== view.catalog ||
		inventory.state !== view.state ||
		inventory.sessionIntents !== view.sessionIntents ||
		inventory.desiredControl !== view.desiredControl ||
		inventory.appliedNodes !== view.appliedNodes ||
		inventory.runtimeStateRevision !== view.runtimeStateRevision ||
		inventory.queryKey !== queryKey
	) {
		const entries = hostPluginCatalogEntriesFromView(view, query).sort((left, right) =>
			pluginNodeIndexKey(left.address).localeCompare(pluginNodeIndexKey(right.address)),
		)
		inventory = {
			catalog: view.catalog,
			state: view.state,
			sessionIntents: view.sessionIntents,
			desiredControl: view.desiredControl,
			appliedNodes: view.appliedNodes,
			runtimeStateRevision: view.runtimeStateRevision,
			queryKey,
			entries,
			signature: hash([
				state.id,
				queryKey,
				view.catalog.revision,
				view.runtimeStateRevision,
				entries.map((entry) => pluginNodeIndexKey(entry.address)),
			]),
		}
		state.inventory = inventory
	}
	const { entries, signature } = inventory
	let offset = 0
	if (cursor !== undefined) {
		if (cursor[1] !== signature)
			throw new ScriptError({
				code: 'cursor_stale',
				message: 'Discovery Host or query inputs changed; request the first page again.',
			})
		offset = cursor[2]
		if (offset > entries.length) throw new TypeError('Invalid plugin discovery cursor offset')
	}
	const end = Math.min(offset + query.limit, entries.length)
	return Object.freeze({
		nodes: Object.freeze(hostPluginStatusesFromView(view, entries.slice(offset, end))),
		catalogRevision: view.catalog.revision,
		runtimeStateRevision: view.runtimeStateRevision,
		nextCursor: end < entries.length ? JSON.stringify([1, signature, end]) : null,
	})
}

/** @internal Capture and validate caller-owned query input before asynchronous admission. */
export function captureScriptPluginListOptions(input: ScriptPluginListOptions = {}) {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError('Plugin discovery requires an options object')
	for (const key of Object.keys(input)) {
		if (!['packageName', 'definition', 'limit', 'cursor'].includes(key))
			throw new TypeError(`Unknown plugin discovery option: ${key}`)
	}
	const { packageName, definition, limit: requestedLimit, cursor } = input
	const limit = requestedLimit === undefined ? 50 : requestedLimit
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
		throw new RangeError('Plugin discovery limit must be an integer from 1 to 200')
	if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048))
		throw new TypeError('Plugin discovery cursor must be a bounded string returned by list()')
	if (packageName !== undefined) parsePluginEntryAddress({ kind: 'package-root', packageName })
	return Object.freeze({
		...(packageName === undefined ? {} : { packageName }),
		...(definition === undefined ? {} : { definition: parsePluginDefinitionAddress(definition) }),
		limit,
		cursor,
	})
}

function parseCursor(input: string): readonly [1, string, number] {
	let value: unknown
	try {
		value = JSON.parse(input)
	} catch (cause) {
		throw new TypeError('Invalid plugin discovery cursor', { cause })
	}
	if (
		!Array.isArray(value) ||
		value.length !== 3 ||
		value[0] !== 1 ||
		typeof value[1] !== 'string' ||
		!Number.isSafeInteger(value[2]) ||
		value[2] < 0
	)
		throw new TypeError('Invalid plugin discovery cursor')
	return value as unknown as readonly [1, string, number]
}
