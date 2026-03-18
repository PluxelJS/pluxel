import { BasePlugin, Plugin } from '@pluxel/runtime'
import { v } from '@pluxel/runtime/config'

const FooSchema = v.object({
	enabled: v.optional(v.boolean(), true),
})

@Plugin({ name: 'PluginConfigUse' })
export class PluginConfigUse extends BasePlugin {
	foo = this.configs.use(FooSchema)
}
