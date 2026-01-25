import * as v from 'valibot'

import {
	type NormalizedWretchClientConfig,
	type NormalizedWretchPluginConfig,
	WretchConfigRuntime,
	type WretchPluginClientConfig,
	type WretchPluginConfig,
} from './schema'
import { normalizeBaseUrl } from './url'

export function parseWretchConfig(
	raw: unknown,
	logger?: { warn?: (...args: unknown[]) => void },
): WretchPluginConfig {
	const parsed = v.safeParse(WretchConfigRuntime, raw && typeof raw === 'object' ? raw : {})
	if (!parsed.success)
		logger?.warn?.('Invalid wretch config; falling back to defaults', parsed.issues)
	return parsed.success ? parsed.output : ({} as WretchPluginConfig)
}

export function normalizeWretchConfig(cfg: WretchPluginConfig): NormalizedWretchPluginConfig {
	const defaults: NormalizedWretchClientConfig = {
		baseUrl: normalizeBaseUrl(cfg.defaults?.baseUrl),
		headers: {
			...(cfg.defaults?.headers ?? {}),
		},
		credentials: cfg.defaults?.credentials,
		options: cfg.defaults?.options as Record<string, unknown> | undefined,
	}

	const clients: Record<string, NormalizedWretchClientConfig> = Object.create(null)
	clients.default = defaults

	const mergeClient = (c?: WretchPluginClientConfig): NormalizedWretchClientConfig => ({
		baseUrl: normalizeBaseUrl(c?.baseUrl ?? defaults.baseUrl),
		headers: { ...(defaults.headers ?? {}), ...(c?.headers ?? {}) },
		credentials: c?.credentials ?? defaults.credentials,
		options: (c?.options as Record<string, unknown> | undefined) ?? defaults.options,
	})

	const configured = cfg.clients ?? {}
	for (const [name, c] of Object.entries(configured)) {
		clients[name] = mergeClient(c)
	}

	const desired = typeof cfg.defaultClient === 'string' ? cfg.defaultClient.trim() : ''
	const defaultClientName = desired && desired in clients ? desired : 'default'
	return { defaultClientName, clients }
}
