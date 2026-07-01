import { BasePlugin, Plugin, v } from '@pluxel/runtime'

const FooSchema = v.object({
	enabled: v.optional(v.boolean(), true),
})

@Plugin({ name: 'PluginConfigUse' })
export class PluginConfigUse extends BasePlugin {
	foo = this.configs.use(FooSchema)
}
