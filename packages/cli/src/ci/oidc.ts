import { CLI_DEFAULTS } from '../config'
import { detectCiContext } from './context'

export interface OidcOptions {
	audience?: string
	required?: boolean
	log?: (...args: unknown[]) => void
	env?: NodeJS.ProcessEnv
	tokenEnvKey?: string
}

type FetchFn = (
	input: string,
	init?: {
		method?: string
		headers?: Record<string, string>
		body?: string
	},
) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown> }>

export async function resolveOidcToken(options: OidcOptions = {}) {
	const log = options.log ?? (() => {})
	const env = options.env ?? process.env
	const tokenEnvKey = options.tokenEnvKey ?? CLI_DEFAULTS.publish.oidcTokenEnv
	const override = env?.[tokenEnvKey]
	if (override) return override

	const context = detectCiContext(env)
	if (!context) {
		if (options.required) {
			throw new Error('OIDC token is required but no CI provider was detected')
		}
		return undefined
	}

	if (context.provider === 'gitlab') {
		const token = env?.CI_JOB_JWT_V2 ?? env?.CI_JOB_JWT
		if (token) return token
	}

	if (context.provider === 'github') {
		const requestUrl = env?.ACTIONS_ID_TOKEN_REQUEST_URL
		const requestToken = env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN
		if (requestUrl && requestToken) {
			const fetchFn = (globalThis as { fetch?: FetchFn }).fetch
			if (!fetchFn) {
				if (options.required) throw new Error('fetch is not available to request an OIDC token')
				return undefined
			}
			const url = options.audience
				? `${requestUrl}${requestUrl.includes('?') ? '&' : '?'}audience=${encodeURIComponent(options.audience)}`
				: requestUrl
			const res = await fetchFn(url, {
				headers: {
					Authorization: `bearer ${requestToken}`,
				},
			})
			if (!res.ok) {
				const reason = `${res.status} ${res.statusText}`.trim()
				if (options.required) {
					throw new Error(`Failed to fetch GitHub OIDC token (${reason})`)
				}
				log(`[publish] warn: unable to fetch GitHub OIDC token (${reason})`)
				return undefined
			}
			const payload = await res.json()
			if (typeof (payload as Record<string, unknown>)?.value === 'string') {
				return (payload as { value: string }).value
			}
			if (options.required) throw new Error('GitHub OIDC response missing token value')
			return undefined
		}
	}

	if (options.required) {
		throw new Error(
			`OIDC token is required but missing provider credentials for ${context.provider}`,
		)
	}
	return undefined
}
