import { ForkablePlugin, Plugin } from '@pluxel/hmr'

import { buildClientEntry, type ClientEntry, type WretchClient } from './client'
import { normalizeWretchConfig, parseWretchConfig } from './config'
import { WretchConfig } from './schema'

export type HttpClient = WretchClient
export * as middlewares from 'wretch/middlewares'

export interface ClientOverrides {
	baseUrl?: string
	prefixUrl?: string
	headers?: Record<string, string>
	/**
	 * Kept for backward compatibility with older template runtimes.
	 * Wretch itself already provides primitives for HTTP error handling.
	 */
	throwHttpErrors?: boolean
}

@Plugin({ name: 'Wretch' })
export class WretchPlugin extends ForkablePlugin {
	wretch = this.configs.use(WretchConfig)

	private defaultClientName = 'default'
	private readonly clients = new Map<string, ClientEntry>()

	override init(): void {
		const cfg = parseWretchConfig(this.wretch, this.ctx.logger)
		const normalized = normalizeWretchConfig(cfg)

		this.clients.clear()
		this.defaultClientName = normalized.defaultClientName

		for (const [name, clientCfg] of Object.entries(normalized.clients)) {
			this.clients.set(name, buildClientEntry(clientCfg))
		}

		// Normalize: ensure at least one safe fallback exists.
		if (!this.clients.has('default')) {
			this.clients.set(
				'default',
				buildClientEntry({ headers: Object.create(null) as Record<string, string> }),
			)
		}
		if (!this.clients.has(this.defaultClientName)) this.defaultClientName = 'default'
	}

	/**
	 * Get a configured wretch instance.
	 *
	 * This plugin intentionally follows wretch's philosophy:
	 * - no extra "fetch wrapper" APIs;
	 * - you decide how to build chains, addons, catchers, etc.
	 */
	client(name?: string): WretchClient {
		return this.getClientEntry(name).client
	}

	/**
	 * Backward-compatible alias for template runtimes.
	 *
	 * Prefer `client(name?)` for the upstream API.
	 */
	createClient(overrides: ClientOverrides = {}): WretchClient {
		let client = this.client()

		const withUrl = (c: WretchClient) =>
			c as unknown as WretchClient & { url: (url: string, replace?: boolean) => WretchClient }

		if (overrides.baseUrl) {
			// `replace=true` resets current url chain.
			client = withUrl(client).url(overrides.baseUrl, true)
		}
		if (overrides.prefixUrl) {
			client = withUrl(client).url(overrides.prefixUrl)
		}
		if (overrides.headers && Object.keys(overrides.headers).length > 0) {
			client = client.headers(overrides.headers)
		}

		return client
	}

	private resolveClientName(name?: string): string {
		const trimmed = name?.trim?.()
		if (trimmed && this.clients.has(trimmed)) return trimmed
		return this.defaultClientName
	}

	private getClientEntry(name?: string): ClientEntry {
		const resolved = this.resolveClientName(name)
		return this.clients.get(resolved) ?? this.clients.get('default')!
	}
}

// biome-ignore lint/style/noDefaultExport: plugin ctors are intentionally default-exported for ergonomic host imports.
export default WretchPlugin
