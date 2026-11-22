import { MarketError, object, packageName, registry, registryBase } from './protocol'

export type GitHubPublisher = {
	name: string
	repositoryId: string
	repositoryOwnerId: string
	workflowRef: string
	jobWorkflowRef?: string
}

export type RegistrySource = {
	registry: string
	access: 'public' | 'admin'
	/** Optional upstream read credential, supplied by deployment secrets only. */
	token?: string
	/** Separate capability for notification submission and private receipt lookup. */
	notificationToken?: string
	githubPublishers?: GitHubPublisher[]
}

function githubPublishers(value: unknown): GitHubPublisher[] {
	if (!Array.isArray(value) || value.length > 5000)
		throw new Error('githubPublishers must be an array of at most 5000 package rules')
	const workflowRef =
		/^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+\.ya?ml@refs\/(heads|tags)\/[^\s@*]+$/
	const jobWorkflowRef = /^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+\.ya?ml@[a-f0-9]{40}$/
	const id = /^[1-9]\d{0,19}$/
	return value.map((entry: unknown) => {
		if (
			!object(entry) ||
			!packageName(entry.name) ||
			typeof entry.repositoryId !== 'string' ||
			!id.test(entry.repositoryId) ||
			typeof entry.repositoryOwnerId !== 'string' ||
			!id.test(entry.repositoryOwnerId) ||
			typeof entry.workflowRef !== 'string' ||
			!workflowRef.test(entry.workflowRef) ||
			(entry.jobWorkflowRef !== undefined &&
				(typeof entry.jobWorkflowRef !== 'string' || !jobWorkflowRef.test(entry.jobWorkflowRef))) ||
			Object.keys(entry).some(
				(key) =>
					!['name', 'repositoryId', 'repositoryOwnerId', 'workflowRef', 'jobWorkflowRef'].includes(
						key,
					),
			)
		)
			throw new Error(
				'Each githubPublishers rule needs a package name, numeric repository and owner IDs, an exact caller workflow ref, and an optional SHA-pinned reusable workflow ref',
			)
		return {
			name: entry.name,
			repositoryId: entry.repositoryId,
			repositoryOwnerId: entry.repositoryOwnerId,
			workflowRef: entry.workflowRef,
			jobWorkflowRef: entry.jobWorkflowRef,
		}
	})
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
			(value.githubPublishers !== undefined && value.access !== 'public') ||
			['token', 'notificationToken'].some(
				(key) =>
					value[key] !== undefined &&
					(typeof value[key] !== 'string' || !value[key] || /[\r\n]/.test(value[key])),
			) ||
			Object.keys(value).some(
				(key) =>
					!['registry', 'access', 'token', 'notificationToken', 'githubPublishers'].includes(key),
			)
		)
			throw new Error(
				'Each registry source needs registry and access (public/admin). githubPublishers is available for public sources.',
			)
		const base = registryBase(value.registry)
		if (seen.has(base)) throw new Error('REGISTRIES contains a duplicate registry')
		seen.add(base)
		return {
			registry: base,
			access: value.access,
			token: value.token as string | undefined,
			notificationToken: value.notificationToken as string | undefined,
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
