import { isNode, isWorkerd } from 'std-env'
import { assertCoreConfigObject } from '../context/core-config-object'
import type {
	OutboundFetch,
	OutboundHttpEffectiveSettings,
	OutboundHttpLimits,
	OutboundHttpOptions,
	OutboundHttpRecords,
	OutboundHttpSettings,
} from './types'

const settingsFields = new Set(['allowedOrigins', 'headers', 'timeoutMs', 'proxyUrl'])
const optionFields = new Set([
	...settingsFields,
	'managed',
	'records',
	'allowProxyChanges',
	'fetch',
	'maxConcurrentRequests',
	'maxQueuedRequests',
])
const unmanagedFields = new Set(['managed', 'fetch'])
const supportsManagedProxy = isNode && !isWorkerd
const reservedHeaders = new Set([
	'__proto__',
	'authorization',
	'connection',
	'constructor',
	'content-length',
	'cookie',
	'host',
	'keep-alive',
	'proxy-authorization',
	'prototype',
	'set-cookie',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'x-api-key',
])

export type ResolvedManagedOutboundHttpOptions = Readonly<{
	managed: true
	records: OutboundHttpRecords
	settings: OutboundHttpSettings
	limits: OutboundHttpLimits
	fetch?: OutboundFetch
}>

export type ResolvedOutboundHttpOptions =
	| Readonly<{ managed: false; fetch?: OutboundFetch }>
	| ResolvedManagedOutboundHttpOptions

function integer(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
		throw new RangeError(
			'[core.http] ' + name + ' must be an integer between ' + min + ' and ' + max,
		)
	return value
}

function origin(input: unknown, name: string): string {
	if (typeof input !== 'string')
		throw new TypeError('[core.http] ' + name + ' must be a URL string')
	let url: URL
	try {
		url = new URL(input)
	} catch {
		throw new TypeError('[core.http] ' + name + ' must be an absolute HTTP(S) origin')
	}
	if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.href !== url.origin + '/') {
		throw new TypeError(
			'[core.http] ' +
				name +
				' must be an HTTP(S) origin without credentials, path, query or fragment',
		)
	}
	return url.origin
}

function headers(input: unknown): Readonly<Record<string, string>> {
	assertCoreConfigObject(input, '[core.http] headers')
	const entries = Object.entries(input as Record<string, unknown>)
	if (entries.length > 32) throw new RangeError('[core.http] headers cannot exceed 32 entries')
	const normalized = new Headers()
	for (const [name, value] of entries) {
		const lower = name.toLowerCase()
		if (reservedHeaders.has(lower))
			throw new TypeError('[core.http] header "' + lower + '" cannot be configured as a default')
		if (typeof value !== 'string' || value.length > 4_096)
			throw new TypeError(
				'[core.http] header "' + lower + '" requires a string of at most 4096 characters',
			)
		if (normalized.has(name))
			throw new TypeError('[core.http] duplicate default header "' + lower + '"')
		normalized.set(name, value)
	}
	return Object.freeze(Object.fromEntries(normalized))
}

export function normalizeOutboundHttpSettings(
	input: unknown,
	deployment = false,
): OutboundHttpSettings {
	assertCoreConfigObject(input, '[core.http] settings', settingsFields)
	const value = input as OutboundHttpSettings
	let allowedOrigins: readonly string[] | undefined
	if (value.allowedOrigins !== undefined) {
		if (!Array.isArray(value.allowedOrigins))
			throw new TypeError('[core.http] allowedOrigins must be an array')
		allowedOrigins = Object.freeze([
			...new Set(
				Array.from(value.allowedOrigins, (entry) => origin(entry, 'allowedOrigins entry')),
			),
		])
	}
	const timeoutMs =
		value.timeoutMs === undefined
			? undefined
			: integer(value.timeoutMs, 'timeoutMs', deployment ? 0 : 1, 2_147_483_647)
	const proxyUrl = value.proxyUrl == null ? value.proxyUrl : origin(value.proxyUrl, 'proxyUrl')
	return Object.freeze({
		...(allowedOrigins === undefined ? {} : { allowedOrigins }),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		...(value.headers === undefined ? {} : { headers: headers(value.headers) }),
		...(proxyUrl === undefined ? {} : { proxyUrl }),
	})
}

export function snapshotOutboundHttpOptions(
	input: OutboundHttpOptions = {},
): ResolvedOutboundHttpOptions {
	assertCoreConfigObject(input, '[core.http] options', optionFields)
	const { fetch, managed } = input
	if (fetch !== undefined && typeof fetch !== 'function')
		throw new TypeError('[core.http] fetch must be a function')
	const transport = fetch === undefined ? {} : { fetch }
	if (managed === false) {
		assertCoreConfigObject(input, '[core.http] unmanaged options', unmanagedFields)
		return Object.freeze({ managed: false, ...transport })
	}
	if (managed !== undefined && managed !== true)
		throw new TypeError('[core.http] managed must be a boolean')
	const {
		fetch: _fetch,
		managed: _managed,
		records = 'requests',
		allowProxyChanges,
		maxConcurrentRequests,
		maxQueuedRequests,
		...rawSettings
	} = input
	if (records !== 'requests' && records !== 'summary' && records !== 'off')
		throw new TypeError('[core.http] records must be requests, summary or off')
	if (allowProxyChanges !== undefined && typeof allowProxyChanges !== 'boolean')
		throw new TypeError('[core.http] allowProxyChanges must be a boolean')
	const settings = normalizeOutboundHttpSettings(rawSettings, true)
	if (!supportsManagedProxy && (settings.proxyUrl != null || allowProxyChanges === true))
		throw new TypeError('[core.http] managed proxies require a Node host')
	const limits = Object.freeze({
		...(settings.allowedOrigins === undefined ? {} : { allowedOrigins: settings.allowedOrigins }),
		timeoutMs: settings.timeoutMs ?? 30_000,
		maxConcurrentRequests: integer(
			maxConcurrentRequests === undefined ? 64 : maxConcurrentRequests,
			'maxConcurrentRequests',
			1,
		),
		maxQueuedRequests: integer(
			maxQueuedRequests === undefined ? 256 : maxQueuedRequests,
			'maxQueuedRequests',
			0,
		),
		allowProxyChanges: allowProxyChanges ?? supportsManagedProxy,
	})
	return Object.freeze({ managed: true, records, settings, limits, ...transport })
}

export function effectiveOutboundHttpSettings(
	options: ResolvedManagedOutboundHttpOptions,
	defaults: OutboundHttpSettings,
	node?: OutboundHttpSettings,
): OutboundHttpEffectiveSettings {
	let allowedOrigins = options.limits.allowedOrigins
	let timeoutMs = options.limits.timeoutMs
	for (const layer of [defaults, node]) {
		if (layer?.allowedOrigins !== undefined) {
			const base = new Set(allowedOrigins ?? layer.allowedOrigins)
			allowedOrigins = Object.freeze(layer.allowedOrigins.filter((value) => base.has(value)))
		}
		if (layer?.timeoutMs !== undefined)
			timeoutMs = timeoutMs > 0 ? Math.min(timeoutMs, layer.timeoutMs) : layer.timeoutMs
	}
	const proxyOverride = node?.proxyUrl !== undefined ? node.proxyUrl : defaults.proxyUrl
	const proxyUrl =
		options.limits.allowProxyChanges && proxyOverride !== undefined
			? proxyOverride
			: (options.settings.proxyUrl ?? null)
	return Object.freeze({
		...(allowedOrigins === undefined ? {} : { allowedOrigins }),
		timeoutMs,
		headers: Object.freeze({ ...options.settings.headers, ...defaults.headers, ...node?.headers }),
		proxyUrl,
	})
}
