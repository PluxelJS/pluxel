import type { HostOperationOptions } from './coordinator'
import { coercePluginConfigRecords } from './config-records'
import { isConfigObject } from './config-paths'
import { SuperJSON } from 'superjson'
import type { PluginConfigRecordSnapshot } from '@pluxel/core/services'

/** Durable version of the complete saved layer, independent from local config revisions. */
export type HostConfigVersion = Readonly<{ history: string; seq: number }>
export type HostConfigMutationOptions = HostOperationOptions &
	Readonly<{ expected?: HostConfigVersion }>

/** Existing application facts from pluxel-deployment.json, supplied by the deployment. */
export type HostConfigArtifact = Readonly<{ name: string; catalogHash: string }>

type SharedConfigSyncOptions = Readonly<{
	scope: string
	artifact: HostConfigArtifact
}>

export type HostConfigSyncOptions = SharedConfigSyncOptions &
	(
		| Readonly<{
				role: 'writer'
				identity: string
				/** Deployment credentials, never accepted from the replicated document. */
				replicas: readonly Readonly<{ identity: string; token: string }>[]
		  }>
		| Readonly<{
				role: 'replica'
				identity: string
				writer: string
				/** Authenticated writer endpoint, mounted by the deployment independently of Plugins. */
				url: string
				token: string
		  }>
	)

/** One atomic config.json document. Body is the writer's exact serialized saved layer. */
export type HostConfigSyncSnapshot = Readonly<{
	version: 4
	protocol: 'pluxel.config-sync/1'
	scope: string
	writer: string
	artifact: HostConfigArtifact
	history: string
	seq: number
	body: string
}>

export type HostConfigSyncStatus = Readonly<{
	role: 'writer' | 'replica'
	scope: string
	writer: string
	artifact: HostConfigArtifact
	sourceVersion: HostConfigVersion | null
	savedVersion: HostConfigVersion | null
	connection: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'
	error: string | null
	unavailable: readonly import('@pluxel/core').PluginNodeAddress[]
}>

export interface HostConfigSync {
	status(): HostConfigSyncStatus
	/** Writer-only Fetch handler. The embedding server owns HTTP/TLS listening. */
	fetch(request: Request): Promise<Response>
}

export class HostConfigVersionConflictError extends Error {
	readonly code = 'version_conflict' as const
	constructor(public readonly version: HostConfigVersion | null) {
		super('[host:config] Expected saved history and sequence do not match the current document.')
		this.name = 'HostConfigVersionConflictError'
	}
}

export const CONFIG_SYNC_MAX_BYTES = 4 * 1024 * 1024
const MAX_RECORDS = 4096
const MAX_SAVED_DEPTH = 128
const MAX_SAVED_VALUES = 100_000

export function configVersion(snapshot: HostConfigSyncSnapshot | null): HostConfigVersion | null {
	return snapshot ? Object.freeze({ history: snapshot.history, seq: snapshot.seq }) : null
}

export function sameConfigVersion(
	a: HostConfigVersion | null | undefined,
	b: HostConfigVersion | null | undefined,
): boolean {
	return !!a && !!b && a.history === b.history && a.seq === b.seq
}

export function assertConfigArtifact(input: unknown): asserts input is HostConfigArtifact {
	const value = exact(input, ['name', 'catalogHash'], 'config sync artifact')
	boundedString(value.name, 256, 'config sync artifact.name')
	if (typeof value.catalogHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.catalogHash))
		throw new TypeError('[host:config-sync] artifact.catalogHash must be a SHA-256 digest')
}

export function snapshotConfigSyncOptions(input: HostConfigSyncOptions): HostConfigSyncOptions {
	const role = (input as { role?: unknown } | null)?.role
	const value = exact(
		input,
		role === 'writer'
			? ['role', 'scope', 'artifact', 'identity', 'replicas']
			: ['role', 'scope', 'artifact', 'identity', 'writer', 'url', 'token'],
		'config sync options',
	)
	if (role !== 'writer' && role !== 'replica')
		throw new TypeError('[host:config-sync] role must be writer or replica')
	boundedString(value.scope, 256, 'config sync scope')
	identity(value.identity)
	assertConfigArtifact(value.artifact)
	const shared = {
		scope: value.scope as string,
		identity: value.identity as string,
		artifact: Object.freeze({ ...value.artifact }),
	}
	if (role === 'writer') {
		if (!Array.isArray(value.replicas) || value.replicas.length > 1024)
			throw new TypeError('[host:config-sync] replicas must be a bounded credential list')
		const seen = new Set<string>()
		const replicas = value.replicas.map((item) => {
			const peer = exact(item, ['identity', 'token'], 'config replica credential')
			identity(peer.identity)
			token(peer.token)
			if (peer.identity === value.identity || seen.has(peer.identity as string))
				throw new TypeError('[host:config-sync] replica identities must be unique')
			seen.add(peer.identity as string)
			return Object.freeze({ identity: peer.identity as string, token: peer.token as string })
		})
		return Object.freeze({ ...shared, role, replicas: Object.freeze(replicas) })
	}
	identity(value.writer)
	if (value.writer === value.identity)
		throw new TypeError('[host:config-sync] writer and replica identities must differ')
	token(value.token)
	const url = new URL(value.url as string)
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
		throw new TypeError(
			'[host:config-sync] url must be an HTTP(S) endpoint without credentials or hash',
		)
	if (url.search)
		throw new TypeError('[host:config-sync] url must not contain protocol query parameters')
	return Object.freeze({
		...shared,
		role,
		writer: value.writer as string,
		token: value.token as string,
		url: url.href,
	})
}

export function decodeConfigSyncSnapshot(
	input: unknown,
	options: HostConfigSyncOptions,
): Readonly<{ snapshot: HostConfigSyncSnapshot; records: readonly PluginConfigRecordSnapshot[] }> {
	if (input && typeof input === 'object' && 'version' in input && input.version !== 4)
		throw new Error(
			'[host:config-sync] Unsupported config document format; explicit conversion is required',
		)
	const value = exact(
		input,
		['version', 'protocol', 'scope', 'writer', 'artifact', 'history', 'seq', 'body'],
		'config sync snapshot',
	)
	if (value.version !== 4 || value.protocol !== 'pluxel.config-sync/1')
		throw new Error(
			'[host:config-sync] Unsupported config document format; explicit conversion is required',
		)
	assertConfigArtifact(value.artifact)
	if (
		value.scope !== options.scope ||
		value.writer !== (options.role === 'writer' ? options.identity : options.writer) ||
		value.artifact.name !== options.artifact.name ||
		value.artifact.catalogHash !== options.artifact.catalogHash
	)
		throw new Error(
			'[host:config-sync] Snapshot source, scope or application artifact does not match deployment',
		)
	boundedString(value.history, 128, 'config history')
	if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0)
		throw new TypeError('[host:config-sync] sequence must be a nonnegative safe integer')
	if (
		typeof value.body !== 'string' ||
		new TextEncoder().encode(value.body).byteLength > CONFIG_SYNC_MAX_BYTES
	)
		throw new TypeError('[host:config-sync] Saved document exceeds the snapshot budget')
	const body = exact(SuperJSON.parse(value.body), ['version', 'plugins'], 'saved config body')
	if (body.version !== 3) throw new Error('[host:config-sync] Unsupported saved config body format')
	if (!Array.isArray(body.plugins) || body.plugins.length > MAX_RECORDS)
		throw new Error('[host:config-sync] Saved config record budget exceeded')
	const records = coercePluginConfigRecords(body.plugins)
	// SuperJSON can preserve cycles and compact shared graphs. Saved layers must also be safe for
	// recursive merge/source inspection before any durable commit, including unknown Plugin owners.
	let values = 0
	const ancestors = new Set<object>()
	const visit = (child: unknown, depth: number): void => {
		if (++values > MAX_SAVED_VALUES || depth > MAX_SAVED_DEPTH)
			throw new TypeError('[host:config-sync] Saved config structure exceeds the merge budget')
		if (!Array.isArray(child) && !isConfigObject(child)) return
		if (ancestors.has(child))
			throw new TypeError('[host:config-sync] Saved config objects and arrays must be acyclic')
		ancestors.add(child)
		for (const nested of Object.values(child)) visit(nested, depth + 1)
		ancestors.delete(child)
	}
	for (const record of records) visit(record.config, 0)
	return {
		snapshot: Object.freeze({
			version: 4,
			protocol: 'pluxel.config-sync/1',
			scope: value.scope as string,
			writer: value.writer as string,
			artifact: Object.freeze({ ...value.artifact }),
			history: value.history as string,
			seq: value.seq as number,
			body: value.body,
		}),
		records,
	}
}

export function createConfigSyncSnapshot(
	options: HostConfigSyncOptions,
	records: readonly PluginConfigRecordSnapshot[],
	version: HostConfigVersion,
): HostConfigSyncSnapshot {
	return decodeConfigSyncSnapshot(
		{
			version: 4,
			protocol: 'pluxel.config-sync/1',
			scope: options.scope,
			writer: options.role === 'writer' ? options.identity : options.writer,
			artifact: options.artifact,
			...version,
			body: SuperJSON.stringify({ version: 3, plugins: records }),
		},
		options,
	).snapshot
}

function identity(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value))
		throw new TypeError(
			'[host:config-sync] identity must contain 1–128 letters, digits, dots, dashes or underscores',
		)
}
function token(value: unknown): asserts value is string {
	if (typeof value !== 'string' || value.length < 16 || value.length > 4096 || /[\r\n]/.test(value))
		throw new TypeError(
			'[host:config-sync] credential must contain 16–4096 characters without line breaks',
		)
}
function boundedString(value: unknown, max: number, label: string): asserts value is string {
	if (typeof value !== 'string' || !value.trim() || value.length > max)
		throw new TypeError(`[host:config-sync] ${label} must be a nonempty bounded string`)
}
function exact(input: unknown, fields: readonly string[], label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError(`[host:config-sync] ${label} must be an object`)
	const descriptors = Object.getOwnPropertyDescriptors(input)
	if (
		Object.getOwnPropertySymbols(input).length > 0 ||
		Object.keys(descriptors).length !== fields.length ||
		fields.some((field) => !descriptors[field] || !('value' in descriptors[field]!))
	)
		throw new TypeError(`[host:config-sync] ${label} has invalid fields`)
	return input as Record<string, unknown>
}
