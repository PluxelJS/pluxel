import { BasePlugin, Config, Plugin } from '@pluxel/core'
import { f, v } from '@pluxel/hmr/config'

export const config = v.object({
	name: v.optional(
		v.pipe(
			v.string(),
			v.hexColor(),
		),
		'#000000',
	),
})
const CfgSchema = v.object({
	driver: v.optional(v.picklist(['libsql']), 'libsql'),
	dbName: v.optional(v.string(), './data/pluxel.sqlite'),
	authToken: v.optional(v.string()),
	debug: v.optional(v.boolean(), false),
	ensureSchemaOnInit: v.optional(v.boolean(), true),
	mikroOptions: v.optional(v.record(v.string(), v.any()), {}),
})

@Plugin({ name: 'PluginB', type: 'hook' })
export class PluginB extends BasePlugin {
	@Config(config)
	private a: Config<typeof config>
	@Config(CfgSchema)
	private ba: Config<typeof CfgSchema>
	init(): void {
		this.ctx.logger.info('PluginB initialized')
	}

	doSomething(): void {
		// this.ctx.logger.info(this.ctx.caller, 'call from')
		this.ctx.logger.info('PluginB doing something...')
	}
}
