import { BasePlugin, Plugin, v } from '@pluxel/runtime'

const Schema = v.object({
	a: v.optional(v.string(), 'a'),
	ba: v.optional(v.number(), 1),
})

@Plugin({ displayName: 'Plugin B' })
export class PluginB extends BasePlugin {
	readonly config = this.configs.use(Schema)
}
