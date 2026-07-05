import { BasePlugin, Plugin, v } from '@pluxel/runtime'

const SchemaA = v.object({
	a: v.optional(v.string(), 'a'),
})

const SchemaBA = v.object({
	ba: v.optional(v.number(), 1),
})

@Plugin({ name: 'PluginB' })
export class PluginB extends BasePlugin {
	readonly a = this.configs.use(SchemaA)
	readonly ba = this.configs.use(SchemaBA)
}
