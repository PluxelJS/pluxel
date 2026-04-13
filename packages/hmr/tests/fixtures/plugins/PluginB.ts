import { BasePlugin, Plugin } from '@pluxel/runtime'
import { v } from '@pluxel/runtime/config'

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
