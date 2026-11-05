import { MarketError, object, readJson } from './protocol'

/** Repository links are package metadata, independent of verified build provenance. */
export async function repositoryStars(repository: string) {
	const url = new URL(repository)
	const match = /^\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(url.pathname)
	if (url.origin !== 'https://github.com' || !match)
		throw new MarketError(
			'repository-provider-unsupported',
			'Star observations currently support GitHub repositories only',
			422,
		)
	const observedAt = Date.now()
	let response: Response
	try {
		response = await fetch(
			`https://api.github.com/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`,
			{
				headers: {
					Accept: 'application/vnd.github+json',
					'User-Agent': 'pluxel-plugin-market',
					'X-GitHub-Api-Version': '2022-11-28',
				},
				redirect: 'manual',
				signal: AbortSignal.timeout(10_000),
			},
		)
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
		value.full_name.toLowerCase() !== `${match[1]}/${match[2]}`.toLowerCase() ||
		!Number.isSafeInteger(value.stargazers_count) ||
		(value.stargazers_count as number) < 0
	)
		throw new MarketError(
			'invalid-repository-response',
			'The repository API did not return the selected repository and a valid star count',
			502,
		)
	return { stars: value.stargazers_count as number, observedAt }
}
