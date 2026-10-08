import { BasePlugin, Plugin } from '@pluxel/core'
import { Launcher, Network, Clipboard } from '@embedded-launcher/sdk'
import * as v from 'valibot'
import wretch from 'wretch'
const Config = v.object({
	endpoint: v.optional(
		v.pipe(v.string(), v.url()),
		'https://jsonplaceholder.typicode.com/todos?_limit=5',
	),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)), 5),
})
const Item = v.object({ id: v.union([v.string(), v.number()]), title: v.string() })
const Items = v.pipe(v.array(Item), v.maxLength(100))
@Plugin({ displayName: 'Remote Lookup' })
export class RemoteLookup extends BasePlugin {
	private readonly config = this.configs.use(Config)
	private settings = { endpoint: '', limit: 5 }
	protected override init() {
		this.settings = { endpoint: this.config.endpoint, limit: this.config.limit }
		this.configs.onUpdate(this.config, ({ desired }) => {
			this.settings = { endpoint: desired.endpoint, limit: desired.limit }
		})
		const network = this.ctx.require(Network),
			clipboard = this.ctx.require(Clipboard)
		this.ctx.require(Launcher).register('remote', async ({ text, signal }) => {
			if (!text.startsWith('web ')) return []
			const query = text.slice(4).trim()
			if (!query) return []
			const endpoint = new URL(this.settings.endpoint)
			endpoint.searchParams.set('q', query)
			const data = await wretch(endpoint.href)
				.fetchPolyfill(network.fetch)
				.options({ signal })
				.get()
				.json()
			const items = v.parse(Items, data)
			return items.slice(0, this.settings.limit).map((item) => ({
				id: String(item.id),
				title: item.title,
				subtitle: endpoint.origin,
				action: {
					label: '复制标题',
					execute: async (actionSignal) => ({
						...(await clipboard.write(item.title, actionSignal)),
					}),
				},
			}))
		})
	}
}
