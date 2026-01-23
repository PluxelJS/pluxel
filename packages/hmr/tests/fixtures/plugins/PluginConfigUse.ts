import { BasePlugin, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'

const FooSchema = v.object({
	enabled: v.optional(v.boolean(), true),
})

@Plugin({ name: 'PluginConfigUse' })
export class PluginConfigUse extends BasePlugin {
	foo = this.configs.use(FooSchema)
}
