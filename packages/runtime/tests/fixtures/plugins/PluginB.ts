import { BasePlugin, Plugin, v } from '@pluxel/runtime'

export const config = v.object({
	name: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
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
	private a = this.configs.use(config)
	private ba = this.configs.use(CfgSchema)
	override init(): void {
		void this.a
		void this.ba

		this.ctx.logger.info('PluginB initialized')
		throw new Error('a')
	}

	doSomething(): void {
		// this.ctx.logger.info(this.ctx.caller, 'call from')
		this.ctx.logger.info('PluginB doing something...')
	}
}
