import {
	encodePluginNodeAddressBytes,
	parsePluginNodeAddress,
	pluginNodeAddressEqual,
	type PluginNodeAddress,
} from '@pluxel/core'
import { createHash } from 'node:crypto'
import type { Row, Store } from 'tinybase'
import type { Dispatcher } from 'undici'
import type { WretchManagedSettings } from './workbench.ts'

const MAX_HEADERS = 32
const MAX_HEADER_VALUE_LENGTH = 4_096
const SENSITIVE_HEADERS = new Set([
	'authorization',
	'cookie',
	'proxy-authorization',
	'set-cookie',
	'x-api-key',
])
const TRANSPORT_HEADERS = new Set([
	'connection',
	'content-length',
	'host',
	'keep-alive',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
])

export type ManagedSettingsState = {
	readonly owner: PluginNodeAddress
	current: WretchManagedSettings
	dispatcher?: Dispatcher
	active: boolean
}

class AsyncLock {
	private tail: Promise<void> = Promise.resolve()

	async run<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.tail
		let release!: () => void
		this.tail = new Promise<void>((resolve) => (release = resolve))
		await previous
		try {
			return await operation()
		} finally {
			release()
		}
	}
}

const SETTINGS_TABLE = 'consumerSettings'

/** A failure after this boundary leaves the new settings saved and applied. */
export class WretchSettingsCleanupError extends Error {
	readonly code = 'SETTINGS_APPLIED_CLEANUP_FAILED'
	readonly applied = true

	constructor(cause: unknown) {
		super('Managed Wretch settings were saved and applied, but previous proxy cleanup failed', {
			cause,
		})
		this.name = 'WretchSettingsCleanupError'
	}
}

/** Serializes the whole provider table: one consumer cannot flush another's candidate. */
export class ManagedSettingsStore {
	private readonly commits = new AsyncLock()
	private fault?: unknown
	private faulted = false

	constructor(
		private readonly store: Store,
		private readonly flush: () => Promise<void>,
	) {
		for (const [id, row] of Object.entries(store.getTable(SETTINGS_TABLE))) {
			parseStoredSettings(row, undefined, id)
		}
	}

	load(owner: PluginNodeAddress): Promise<ManagedSettingsState> {
		return this.commits.run(async () => {
			if (this.faulted) throw this.fault
			const normalizedOwner = parsePluginNodeAddress(owner)
			const id = settingsRowId(normalizedOwner)
			const settings = this.store.hasRow(SETTINGS_TABLE, id)
				? parseStoredSettings(this.store.getRow(SETTINGS_TABLE, id), normalizedOwner, id)
				: emptySettings()
			return {
				owner: normalizedOwner,
				current: settings,
				dispatcher: await dispatcherFor(settings.proxyUrl),
				active: true,
			}
		})
	}

	async replace(
		state: ManagedSettingsState,
		input: unknown,
		maxTimeoutMs = 0,
	): Promise<WretchManagedSettings> {
		const next = normalizeManagedSettings(input)
		if (maxTimeoutMs > 0 && next.timeoutMs !== undefined && next.timeoutMs > maxTimeoutMs) {
			throw new RangeError(`timeoutMs cannot exceed the host limit (${maxTimeoutMs}ms)`)
		}
		return this.commit(state, next, false)
	}

	reset(state: ManagedSettingsState): Promise<WretchManagedSettings> {
		return this.commit(state, emptySettings(), true)
	}

	async dispose(state: ManagedSettingsState): Promise<void> {
		state.active = false
		await this.commits.run(async () => {
			const dispatcher = state.dispatcher
			state.dispatcher = undefined
			await dispatcher?.close()
		})
	}

	private commit(
		state: ManagedSettingsState,
		next: WretchManagedSettings,
		reset: boolean,
	): Promise<WretchManagedSettings> {
		return this.commits.run(async () => {
			if (!state.active) throw new Error('Managed Wretch settings belong to a stopped generation')
			if (this.faulted) throw this.fault
			const dispatcher = await dispatcherFor(next.proxyUrl)
			try {
				this.store.transaction(() => {
					const id = settingsRowId(state.owner)
					if (reset) this.store.delRow(SETTINGS_TABLE, id)
					else
						this.store.setRow(SETTINGS_TABLE, id, {
							version: 1,
							owner: JSON.stringify(state.owner),
							settings: JSON.stringify(next),
						})
				})
				await this.flush()
			} catch (error) {
				// Host faults the writer and blocks autosave/close from retrying this candidate.
				this.faulted = true
				this.fault = error
				const [cleanup] = await Promise.allSettled([dispatcher?.close()])
				if (cleanup.status === 'rejected') {
					throw new AggregateError(
						[error, cleanup.reason],
						'Wretch settings save and candidate cleanup failed',
						{ cause: error },
					)
				}
				throw error
			}
			const previous = state.dispatcher
			state.current = next
			state.dispatcher = dispatcher
			try {
				await previous?.close()
			} catch (cause) {
				throw new WretchSettingsCleanupError(cause)
			}
			return state.current
		})
	}
}

function settingsRowId(owner: PluginNodeAddress): string {
	return createHash('sha256').update(encodePluginNodeAddressBytes(owner)).digest('hex')
}

function emptySettings(): WretchManagedSettings {
	return Object.freeze({ headers: Object.freeze({}) })
}

function normalizedProxyUrl(input: unknown): string | undefined {
	if (input === undefined || input === null || input === '') return undefined
	if (typeof input !== 'string') throw new TypeError('proxyUrl must be a string')
	let url: URL
	try {
		url = new URL(input)
	} catch {
		throw new TypeError('proxyUrl must be an absolute HTTP(S) URL')
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new TypeError('proxyUrl must use HTTP or HTTPS')
	}
	if (url.username || url.password) {
		throw new TypeError('Authenticated proxy URLs are not supported here')
	}
	if (url.pathname !== '/' || url.search || url.hash) {
		throw new TypeError('proxyUrl must be an HTTP(S) origin without path, query, or hash')
	}
	return url.href
}

export function normalizeManagedSettings(input: unknown): WretchManagedSettings {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('Managed Wretch settings must be an object')
	}
	const value = input as Partial<WretchManagedSettings>
	const rawHeaders = value.headers ?? {}
	if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
		throw new TypeError('headers must be an object')
	}
	const entries = Object.entries(rawHeaders)
	if (entries.length > MAX_HEADERS)
		throw new RangeError(`headers cannot exceed ${MAX_HEADERS} entries`)
	const headers: Record<string, string> = Object.create(null)
	for (const [rawName, rawValue] of entries) {
		if (typeof rawValue !== 'string') throw new TypeError(`Header "${rawName}" must be a string`)
		const probe = new Headers({ [rawName]: rawValue })
		const name = [...probe.keys()][0]!
		if (SENSITIVE_HEADERS.has(name)) {
			throw new TypeError(`Header "${name}" is secret-bearing and cannot be stored here`)
		}
		if (TRANSPORT_HEADERS.has(name)) {
			throw new TypeError(`Header "${name}" is owned by the HTTP transport`)
		}
		if (rawValue.length > MAX_HEADER_VALUE_LENGTH) {
			throw new RangeError(`Header "${name}" value is too long`)
		}
		headers[name] = rawValue
	}

	let timeoutMs: number | undefined
	if (value.timeoutMs !== undefined && value.timeoutMs !== null) {
		if (!Number.isInteger(value.timeoutMs) || value.timeoutMs <= 0) {
			throw new RangeError('timeoutMs must be a positive integer')
		}
		timeoutMs = value.timeoutMs
	}
	const proxyUrl = normalizedProxyUrl(value.proxyUrl)

	return Object.freeze({
		headers: Object.freeze(headers),
		...(proxyUrl === undefined ? {} : { proxyUrl }),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	})
}

async function dispatcherFor(proxyUrl?: string): Promise<Dispatcher | undefined> {
	if (!proxyUrl) return undefined
	const { ProxyAgent } = await import('undici')
	return new ProxyAgent(proxyUrl)
}

function parseStoredSettings(
	record: Row,
	expectedOwner: PluginNodeAddress | undefined,
	id: string,
): WretchManagedSettings {
	const keys = Object.keys(record)
	if (
		keys.length !== 3 ||
		!keys.includes('version') ||
		!keys.includes('owner') ||
		!keys.includes('settings') ||
		record.version !== 1 ||
		typeof record.owner !== 'string' ||
		typeof record.settings !== 'string'
	) {
		throw new TypeError('Managed Wretch settings row has an unsupported format')
	}
	const owner = parsePluginNodeAddress(JSON.parse(record.owner) as unknown)
	if (
		settingsRowId(owner) !== id ||
		(expectedOwner && !pluginNodeAddressEqual(owner, expectedOwner))
	) {
		throw new TypeError('Managed Wretch settings owner does not match its row ID')
	}
	return normalizeManagedSettings(JSON.parse(record.settings) as unknown)
}
