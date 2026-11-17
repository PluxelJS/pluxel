export type MarketReceipt = {
	id: string
	registry: string
	name: string
	version: string
	status: 'pending' | 'processing' | 'indexed' | 'failed'
	attempts: number
	createdAt: number
	updatedAt: number
	nextAttemptAt: number | null
	code: string | null
}

export type MarketNotification = { receipt: MarketReceipt; url: string }

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonnegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parseMarketOrigin(value: string): URL {
	const base = new URL(value)
	if (!['http:', 'https:'].includes(base.protocol) || base.href !== `${base.origin}/`) {
		throw new TypeError(
			'The market URL must be an HTTP(S) origin without credentials, path, query or fragment',
		)
	}
	return base
}

/** Submit once; the durable receipt is queried separately and may already be terminal. */
export async function notifyMarket(
	base: URL,
	coordinate: { registry: string; name: string; version: string },
	token?: string,
): Promise<MarketNotification> {
	const { registry, name, version } = coordinate
	const response = await fetch(new URL('/v1/notifications', base), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ registry, name, version }),
		redirect: 'error',
		signal: AbortSignal.timeout(30_000),
	})
	const value: unknown = await response.json().catch((): unknown => null)
	if (response.status !== 200 && response.status !== 202) {
		const code = object(value) && typeof value.code === 'string' ? `, ${value.code}` : ''
		throw new Error(`Market rejected the notification (HTTP ${response.status}${code})`)
	}
	if (
		!object(value) ||
		typeof value.id !== 'string' ||
		!/^[\w-]{1,64}$/.test(value.id) ||
		value.registry !== registry ||
		value.name !== name ||
		value.version !== version ||
		typeof value.status !== 'string' ||
		!['pending', 'processing', 'indexed', 'failed'].includes(value.status) ||
		!nonnegativeInteger(value.attempts) ||
		!nonnegativeInteger(value.createdAt) ||
		!nonnegativeInteger(value.updatedAt) ||
		!(value.nextAttemptAt === null || nonnegativeInteger(value.nextAttemptAt)) ||
		!(value.code === null || typeof value.code === 'string')
	) {
		throw new Error('Market returned an invalid notification receipt')
	}
	return {
		receipt: value as MarketReceipt,
		url: new URL(`/v1/notifications/${value.id}`, base).href,
	}
}
