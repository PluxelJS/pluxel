import { MarketError, object, registry, registryBase } from '../protocol'
import { githubPublishers, type GitHubPublisher } from './github-publisher'

export type RegistrySource = {
	registry: string
	access: 'public' | 'admin'
	/** Read transport for the public npm catalog. The registry owns release identity. */
	mirror?: string
	/** Optional upstream read credential, supplied by deployment secrets only. */
	token?: string
	/** Separate capability for notification submission and private receipt lookup. */
	notificationToken?: string
	/** Private registry policy for automatically indexing releases without attestations. */
	notificationIndexing?: 'unsigned'
	githubPublishers?: GitHubPublisher[]
	/** Transport bound to the current event’s native resources. */
	fetch?: (request: Request) => Promise<Response>
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
			(value.access !== 'public' && value.access !== 'admin') ||
			(value.notificationIndexing !== undefined &&
				(value.notificationIndexing !== 'unsigned' || value.access !== 'admin')) ||
			['token', 'notificationToken'].some(
				(key) =>
					value[key] !== undefined &&
					(typeof value[key] !== 'string' || !value[key] || /[\r\n]/.test(value[key])),
			) ||
			Object.keys(value).some(
				(key) =>
					![
						'registry',
						'mirror',
						'access',
						'token',
						'notificationToken',
						'notificationIndexing',
						'githubPublishers',
					].includes(key),
			)
		)
			throw new Error(
				'Each source needs registry and access (public/admin). Only private sources can set notificationIndexing: unsigned.',
			)
		const base = registryBase(value.registry)
		let mirror: string | undefined
		if (value.mirror !== undefined) {
			if (
				typeof value.mirror !== 'string' ||
				base !== registry ||
				value.access !== 'public' ||
				value.token !== undefined
			)
				throw new Error('mirror requires a public npm source without upstream credentials')
			mirror = registryBase(value.mirror)
		}
		if (seen.has(base)) throw new Error('REGISTRIES contains a duplicate registry')
		seen.add(base)
		return {
			registry: base,
			mirror,
			access: value.access,
			token: value.token as string | undefined,
			notificationToken: value.notificationToken as string | undefined,
			notificationIndexing: value.notificationIndexing as RegistrySource['notificationIndexing'],
			githubPublishers:
				value.githubPublishers === undefined ? undefined : githubPublishers(value.githubPublishers),
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
