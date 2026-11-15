import {
	parsePluginDefinitionAddress,
	parsePluginEntryAddress,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import { Result } from '@pluxel/core/better-result'
import { hash } from 'ohash'
import {
	hostPluginCatalogEntriesFromView,
	hostPluginStatusesFromView,
	type HostPluginStatusProjectionView,
	type HostPluginStatusSnapshot,
} from '../status'
import type { ScriptOperationError } from './sdk-results'

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

// This identifies only the borrowed coordinator's lifetime. Results are not cached:
// every page reads the committed query, revisions and identity sequence again.
const owners = new WeakMap<object, string>()

/** @internal Called under the original coordinator's committed-read boundary. */
export function scriptPluginList(
	owner: object,
	view: HostPluginStatusProjectionView & Readonly<{ runtimeStateRevision: number }>,
	query: ReturnType<typeof captureScriptPluginListOptions> = captureScriptPluginListOptions(),
): Result<ScriptPluginSnapshot, Extract<ScriptPluginListError, { code: 'cursor_stale' }>> {
	let ownerId = owners.get(owner)
	if (!ownerId) {
		ownerId = crypto.randomUUID()
		owners.set(owner, ownerId)
	}
	const entries = hostPluginCatalogEntriesFromView(view, query).sort((left, right) =>
		pluginNodeIndexKey(left.address).localeCompare(pluginNodeIndexKey(right.address)),
	)
	const signature = hash([
		ownerId,
		query.packageName ?? null,
		query.definition ?? null,
		view.catalog.revision,
		view.runtimeStateRevision,
		entries.map((entry) => pluginNodeIndexKey(entry.address)),
	])
	let offset = 0
	if (query.cursor !== undefined) {
		const cursor = parseCursor(query.cursor)
		if (cursor[1] !== signature)
			return Result.err(
				Object.freeze({
					code: 'cursor_stale',
					message: 'Discovery Host or query inputs changed; request the first page again.',
				}),
			)
		offset = cursor[2]
		if (offset > entries.length) throw new TypeError('Invalid plugin discovery cursor offset')
	}
	const end = Math.min(offset + query.limit, entries.length)
	return Result.ok(
		Object.freeze({
			nodes: Object.freeze(hostPluginStatusesFromView(view, entries.slice(offset, end))),
			catalogRevision: view.catalog.revision,
			runtimeStateRevision: view.runtimeStateRevision,
			nextCursor: end < entries.length ? JSON.stringify([1, signature, end]) : null,
		}),
	)
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
