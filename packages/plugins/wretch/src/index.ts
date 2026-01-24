import { Config, ForkablePlugin, Plugin } from '@pluxel/hmr'
import * as v from 'valibot'
import type { InferOutput } from 'valibot'
import wretch, { type Wretch } from 'wretch'

const Credentials = ['omit', 'same-origin', 'include'] as const

const WretchConfig = v.object({
	baseUrl: v.optional(v.string()),
	headers: v.optional(v.record(v.string(), v.string()), {}),
	credentials: v.optional(v.picklist(Credentials)),
})

export type WretchPluginConfig = InferOutput<typeof WretchConfig>

@Plugin({ name: 'Wretch' })
export class WretchPlugin extends ForkablePlugin {
	@Config(WretchConfig) wretch!: WretchPluginConfig

	private base: string | undefined
	private client: Wretch = wretch()

	override init(): void {
		const cfg =
			this.wretch && typeof this.wretch === 'object' ? (this.wretch as WretchPluginConfig) : null

		this.base = cfg?.baseUrl?.trim() || undefined

		let client = wretch()
		const headers = cfg?.headers
		if (headers && Object.keys(headers).length > 0) {
			client = client.headers(headers)
		}
		const credentials = cfg?.credentials
		if (credentials) {
			client = client.options({ credentials })
		}
		this.client = client
	}

	/**
	 * Low-level accessor for advanced use cases (addons/middlewares/etc).
	 * Prefer `url()`/`getJson()` for normal usage.
	 */
	clientRaw(): Wretch {
		return this.client
	}

	/**
	 * Create a request builder for a path (joined with baseUrl if provided).
	 * `path` can be absolute; absolute always wins over baseUrl.
	 */
	url(path: string): Wretch {
		const trimmed = path?.trim?.() ?? ''
		const resolved =
			this.base && trimmed && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
				? new URL(trimmed, this.base).toString()
				: trimmed
		return this.client.url(resolved)
	}

	async getJson<T = unknown>(path: string): Promise<T> {
		return this.url(path).get().json<T>()
	}
}
