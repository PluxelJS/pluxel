import { createMarketRpcClient } from '@pluxel/market'
import { CLI_DEFAULTS } from '../config'

type Logger = (...args: unknown[]) => void

export interface MarketWebhookClient {
	submit(payload: { packageName: string; version: string }, token: string): Promise<unknown>
}

export function resolveMarketWebhookClient(
	baseUrl: string | undefined,
	log: Logger,
): MarketWebhookClient | undefined {
	const resolvedBase = baseUrl || CLI_DEFAULTS.publish.marketBaseUrl
	if (!resolvedBase) {
		log('[publish] warn: market base URL is not configured')
		return undefined
	}
	if (!globalThis.fetch) {
		log('[publish] warn: fetch is required to use market RPC client')
		return undefined
	}

	try {
		const client = createMarketRpcClient({ baseUrl: resolvedBase, fetch: globalThis.fetch })
		if (client?.webhook?.submit) {
			return {
				submit: (payload, token) => client.webhook.submit(payload, token),
			}
		}
		log('[publish] warn: market RPC client did not expose webhook.submit')
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		log(`[publish] warn: failed to initialize market RPC client: ${reason}`)
	}
	return undefined
}
