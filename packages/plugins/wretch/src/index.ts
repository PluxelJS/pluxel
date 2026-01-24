import { Config, ForkablePlugin, Plugin } from '@pluxel/hmr'

import { buildClientEntry, type ClientEntry, type WretchClient } from './client'
import { normalizeWretchConfig, parseWretchConfig } from './config'
import { WretchConfig, type WretchPluginConfig } from './schema'

@Plugin({ name: 'Wretch' })
export class WretchPlugin extends ForkablePlugin {
	@Config(WretchConfig) wretch!: WretchPluginConfig

	private defaultClientName: string = 'default'
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
