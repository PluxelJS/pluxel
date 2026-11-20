import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'

const ProviderConfig = v.object({
	source: v.pipe(v.string(), v.url()),
	name: v.optional(v.string(), 'Pluxel'),
})
const SourcePayload = v.object({ source: v.string() })

@Plugin()
export class Provider extends BasePlugin {
	private readonly config = this.configs.use(ProviderConfig)

	async greet(signal?: AbortSignal) {
		const response = await this.ctx.fetch(this.config.source, { signal })
		if (!response.ok) {
			await response.body?.cancel()
			throw new Error(`Greeting source returned ${response.status}`)
		}
		const { source } = v.parse(SourcePayload, await response.json())
		const store = await this.ctx.tinybase.open()
		const previous = store.getValue('visits')
		const visits = (typeof previous === 'number' ? previous : 0) + 1
		store.setValue('visits', visits)
		await this.ctx.tinybase.flush()
		return { message: `Hello, ${this.config.name}!`, source, visits }
	}
}
