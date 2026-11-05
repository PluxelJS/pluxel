import { MarketError, object, registry, registryBase } from './protocol'

export type RegistrySource = {
	registry: string
	access: 'public' | 'admin'
	/** Optional upstream read credential, supplied by deployment secrets only. */
	token?: string
	/** Separate capability for notification submission and private receipt lookup. */
	notificationToken?: string
}

/** Deployment-owned allowlist; notification senders cannot add network targets. */
export function registrySources(raw?: string): RegistrySource[] {
	if (raw === undefined) return [{ registry, access: 'public' }]
	let values: unknown
	try {
		values = JSON.parse(raw)
	} catch {
		throw new Error('REGISTRIES must be a JSON array of registry sources')
	}
	if (!Array.isArray(values) || values.length === 0 || values.length > 20)
		throw new Error('REGISTRIES must contain 1–20 sources')
	const seen = new Set<string>()
	return values.map((value: unknown) => {
		if (
			!object(value) ||
			typeof value.registry !== 'string' ||
			!['public', 'admin'].includes(String(value.access)) ||
			['token', 'notificationToken'].some(
				(key) =>
					value[key] !== undefined &&
					(typeof value[key] !== 'string' || !value[key] || /[\r\n]/.test(value[key])),
			) ||
			Object.keys(value).some(
				(key) => !['registry', 'access', 'token', 'notificationToken'].includes(key),
			)
		)
			throw new Error(
				'Each registry source needs registry, access (public/admin), and an optional token',
			)
		const base = registryBase(value.registry)
		if (seen.has(base)) throw new Error('REGISTRIES contains a duplicate registry')
		seen.add(base)
		return {
			registry: base,
			access: value.access as RegistrySource['access'],
			token: value.token as string | undefined,
			notificationToken: value.notificationToken as string | undefined,
		}
	})
}

export function sourceFor(sources: readonly RegistrySource[], base: string): RegistrySource {
	const source = sources.find((item) => item.registry === base)
	if (!source)
		throw new MarketError(
			'unconfigured-registry',
			'The registry is not configured by this market',
			422,
		)
	return source
}
