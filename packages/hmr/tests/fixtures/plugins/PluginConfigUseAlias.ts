import { BasePlugin, Plugin } from '@pluxel/hmr'
import * as v from 'valibot'

@Plugin({ name: 'PluginConfigUseAlias' })
export class PluginConfigUseAlias extends BasePlugin {
	foo = this.config.use(v.object({ ok: v.optional(v.boolean()) }))
}
