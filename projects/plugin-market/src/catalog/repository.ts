import { MarketError, object, readJson, repositoryOwner } from '../protocol'

export type RepositoryObservation = {
	stars: number
	observedAt: number
	avatarUrl: string | null
}

function avatarUrl(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 2048) return null
	try {
		const url = new URL(value)
		return url.origin === 'https://avatars.githubusercontent.com' && !url.username && !url.password
			? url.href
			: null
	} catch {
		return null
	}
}

/** Repository links are package metadata, independent of verified build provenance. */
export async function observeRepository(
	repository: string,
	eventSignal?: AbortSignal,
): Promise<RepositoryObservation> {
	eventSignal?.throwIfAborted()
	const owner = repositoryOwner(repository)
	if (!owner)
		throw new MarketError(
			'repository-provider-unsupported',
			'Repository observations currently support GitHub repositories only',
			422,
		)
	const fullName = repository.slice('https://github.com/'.length)
	const observedAt = Date.now()
	const deadline = AbortSignal.timeout(10_000)
	let response: Response
	try {
		response = await fetch(`https://api.github.com/repos/${fullName}`, {
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': 'pluxel-plugin-market',
				'X-GitHub-Api-Version': '2022-11-28',
			},
			redirect: 'manual',
			signal: eventSignal ? AbortSignal.any([eventSignal, deadline]) : deadline,
		})
	} catch {
		throw new MarketError(
			'repository-unavailable',
			'The repository API request failed or timed out',
			502,
			true,
		)
	}
	if (!response.ok) {
		await response.body?.cancel()
		throw new MarketError(
			'repository-unavailable',
			`The repository API returned HTTP ${response.status}; the previous observation is preserved`,
			502,
			response.status === 429 || response.status === 403 || response.status >= 500,
		)
	}
	const value = await readJson(response.body, 512 * 1024)
	if (
		!object(value) ||
		typeof value.full_name !== 'string' ||
		value.full_name.toLowerCase() !== fullName.toLowerCase() ||
		typeof value.stargazers_count !== 'number' ||
		!Number.isSafeInteger(value.stargazers_count) ||
		value.stargazers_count < 0 ||
		!object(value.owner) ||
		typeof value.owner.login !== 'string' ||
		value.owner.login.toLowerCase() !== owner.toLowerCase()
	)
		throw new MarketError(
			'invalid-repository-response',
			'The repository API did not return the selected repository, a valid owner, and a valid star count',
			502,
		)
	return {
		stars: value.stargazers_count,
		observedAt,
		avatarUrl: avatarUrl(value.owner.avatar_url),
	}
}
