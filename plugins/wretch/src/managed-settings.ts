import {
	parsePluginNodeAddress,
	pluginNodeAddressEqual,
	type PersistenceNamespace,
	type PluginNodeAddress,
} from '@pluxel/runtime'
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
	lock: AsyncLock
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

	return Object.freeze({
		headers: Object.freeze(headers),
		proxyUrl: normalizedProxyUrl(value.proxyUrl),
		timeoutMs,
	})
}

async function dispatcherFor(proxyUrl?: string): Promise<Dispatcher | undefined> {
	if (!proxyUrl) return undefined
	const { ProxyAgent } = await import('undici')
	return new ProxyAgent(proxyUrl)
}

export async function loadManagedSettings(
	storage: PersistenceNamespace,
	key: string,
	owner: PluginNodeAddress,
): Promise<ManagedSettingsState> {
	const normalizedOwner = parsePluginNodeAddress(owner)
	const text = await storage.getText(key)
	const settings = text === undefined ? emptySettings() : parseStoredSettings(text, normalizedOwner)
	return {
		owner: normalizedOwner,
		current: settings,
		dispatcher: await dispatcherFor(settings.proxyUrl),
		lock: new AsyncLock(),
	}
}

export async function replaceManagedSettings(
	state: ManagedSettingsState,
	storage: PersistenceNamespace,
	key: string,
	input: unknown,
	maxTimeoutMs = 0,
): Promise<WretchManagedSettings> {
	const next = normalizeManagedSettings(input)
	if (maxTimeoutMs > 0 && next.timeoutMs !== undefined && next.timeoutMs > maxTimeoutMs) {
		throw new RangeError(`timeoutMs cannot exceed the host limit (${maxTimeoutMs}ms)`)
	}
	return state.lock.run(async () => {
		const dispatcher = await dispatcherFor(next.proxyUrl)
		try {
			await storage.put(key, serializeStoredSettings(state.owner, next), { atomic: true })
		} catch (error) {
			await dispatcher?.close()
			throw error
		}
		const previous = state.dispatcher
		state.current = next
		state.dispatcher = dispatcher
		await previous?.close()
		return state.current
	})
}

function parseStoredSettings(
	text: string,
	expectedOwner: PluginNodeAddress,
): WretchManagedSettings {
	const input = JSON.parse(text) as unknown
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('Managed Wretch settings file must be an object')
	}
	const record = input as Record<string, unknown>
	const keys = Object.keys(record)
	if (
		keys.length !== 4 ||
		!keys.includes('format') ||
		!keys.includes('version') ||
		!keys.includes('owner') ||
		!keys.includes('settings') ||
		record.format !== 'pluxel-wretch-managed-settings' ||
		record.version !== 2
	) {
		throw new TypeError('Managed Wretch settings file has an unsupported format')
	}
	const owner = parsePluginNodeAddress(record.owner)
	if (!pluginNodeAddressEqual(owner, expectedOwner)) {
		throw new TypeError('Managed Wretch settings owner does not match its storage key')
	}
	return normalizeManagedSettings(record.settings)
}

function serializeStoredSettings(
	owner: PluginNodeAddress,
	settings: WretchManagedSettings,
): string {
	return JSON.stringify({
		format: 'pluxel-wretch-managed-settings',
		version: 2,
		owner,
		settings,
	})
}

export async function resetManagedSettings(
	state: ManagedSettingsState,
	storage: PersistenceNamespace,
	key: string,
): Promise<WretchManagedSettings> {
	const next = emptySettings()
	return state.lock.run(async () => {
		await storage.delete(key)
		const previous = state.dispatcher
		state.current = next
		state.dispatcher = undefined
		await previous?.close()
		return state.current
	})
}

export async function disposeManagedSettings(state: ManagedSettingsState): Promise<void> {
	await state.lock.run(async () => {
		await state.dispatcher?.close()
		state.dispatcher = undefined
	})
}
