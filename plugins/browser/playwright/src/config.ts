import * as v from 'valibot'

const Endpoint = v.pipe(
	v.string(),
	v.url('Expected an absolute HTTP(S) or WebSocket URL'),
	v.check(
		(value) =>
			URL.canParse(value) && ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(value).protocol),
		'Unsupported browser endpoint URL protocol',
	),
)

/** Public deployment configuration. Choose exactly one connection source; restart to apply changes. */
export const PlaywrightConfig = v.pipe(
	v.object({
		protocol: v.optional(v.picklist(['cdp', 'playwright']), 'cdp'),
		endpoint: v.optional(
			v.pipe(
				Endpoint,
				v.check((value) => {
					if (!URL.canParse(value)) return false
					const url = new URL(value)
					return !url.username && !url.password && !url.search && !url.hash
				}, 'Credential-bearing URLs and query strings must use a Vault connectionKey'),
			),
		),
		connectionKey: v.optional(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.check((value) => !value.includes('\0'), 'Invalid Vault key'),
			),
		),
		connectTimeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 30_000),
	}),
	v.check(
		(value) => (value.endpoint !== undefined) !== (value.connectionKey !== undefined),
		'Specify exactly one of endpoint or connectionKey',
	),
	v.check(
		(value) => value.endpoint === undefined || acceptsEndpoint(value.protocol, value.endpoint),
		'Playwright protocol requires a WebSocket endpoint (ws or wss)',
	),
)

export const PlaywrightConnectionSchema = v.object({
	endpoint: Endpoint,
	headers: v.optional(v.record(v.string(), v.string())),
})

/** Root Vault deployment binding schema: records are selected by config.connectionKey. */
export const PlaywrightVaultSchema = v.record(v.string(), PlaywrightConnectionSchema)

export function acceptsEndpoint(protocol: 'cdp' | 'playwright', endpoint: string): boolean {
	return (
		protocol === 'cdp' ||
		(URL.canParse(endpoint) && ['ws:', 'wss:'].includes(new URL(endpoint).protocol))
	)
}
