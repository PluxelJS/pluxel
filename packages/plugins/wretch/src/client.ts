import wretch from 'wretch/all'

import type { NormalizedWretchClientConfig } from './schema'

export type WretchClient = ReturnType<typeof wretch>

export type ClientEntry = {
	client: WretchClient
}

export function buildClientEntry(config: NormalizedWretchClientConfig): ClientEntry {
	const options: Record<string, unknown> & RequestInit = Object.assign(
		Object.create(null),
		config.options ?? {},
		config.credentials ? { credentials: config.credentials } : null,
	)

	let client = config.baseUrl ? wretch(config.baseUrl) : wretch()
	if (config.headers && Object.keys(config.headers).length > 0) client = client.headers(config.headers)
	if (Object.keys(options).length > 0) client = client.options(options)

	return { client }
}
