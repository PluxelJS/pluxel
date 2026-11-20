import type { OutboundHttpSettings } from '@pluxel/services/management/protocol'

export type OutboundHttpFormValues = Readonly<{
	origins: Readonly<{ mode: 'inherit' | 'deny' | 'list'; text: string }>
	proxy: Readonly<{ mode: 'inherit' | 'direct' | 'url'; url: string }>
	timeoutMs: number | string
	headers: string
}>

export function outboundHttpFormValues(settings: OutboundHttpSettings): OutboundHttpFormValues {
	const { allowedOrigins, proxyUrl, timeoutMs, headers } = settings
	return {
		origins: {
			mode: allowedOrigins === undefined ? 'inherit' : allowedOrigins.length > 0 ? 'list' : 'deny',
			text: allowedOrigins?.join('\n') ?? '',
		},
		proxy: {
			mode: proxyUrl === undefined ? 'inherit' : proxyUrl === null ? 'direct' : 'url',
			url: proxyUrl ?? '',
		},
		timeoutMs: timeoutMs ?? '',
		headers: Object.entries(headers ?? {})
			.map(([name, value]) => `${name}: ${value}`)
			.join('\n'),
	}
}

export function readOutboundHttpForm(form: OutboundHttpFormValues): OutboundHttpSettings | null {
	const { origins, proxy, timeoutMs, headers } = form
	const allowedOrigins =
		origins.mode === 'inherit'
			? undefined
			: origins.mode === 'deny'
				? []
				: origins.text
						.split('\n')
						.map((origin) => origin.trim())
						.filter(Boolean)
	if (origins.mode === 'list' && !allowedOrigins?.length) {
		throw new TypeError('请填写允许的目标，或将目标策略设为禁止。')
	}
	const proxyUrl =
		proxy.mode === 'inherit' ? undefined : proxy.mode === 'direct' ? null : proxy.url.trim()
	if (proxyUrl === '') throw new TypeError('请填写代理地址。')
	if (
		timeoutMs !== '' &&
		(typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
	) {
		throw new RangeError('超时必须是正整数。')
	}

	const headerValues = new Map<string, string>()
	for (const line of headers.split('\n')) {
		if (!line.trim()) continue
		const separator = line.indexOf(':')
		const name = separator > 0 ? line.slice(0, separator).trim().toLowerCase() : ''
		if (!name) throw new TypeError('每个请求头必须包含名称和值，用冒号分隔。')
		if (headerValues.has(name)) throw new TypeError(`请求头“${name}”重复。`)
		headerValues.set(name, line.slice(separator + 1).replace(/^ /, ''))
	}

	const settings: OutboundHttpSettings = {
		...(allowedOrigins === undefined ? {} : { allowedOrigins }),
		...(proxyUrl === undefined ? {} : { proxyUrl }),
		...(timeoutMs === '' ? {} : { timeoutMs }),
		...(headerValues.size > 0 ? { headers: Object.fromEntries(headerValues) } : {}),
	}
	return Object.keys(settings).length > 0 ? settings : null
}
