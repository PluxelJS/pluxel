import * as v from 'valibot'
import { BasePlugin, Config as UseConfig, Plugin, type Config as InferConfig } from '@pluxel/hmr'

const aliasSchema = v.object({
	name: v.string(),
})

@Plugin({ name: 'AliasConfigPlugin' })
export class AliasConfigPlugin extends BasePlugin {
	@UseConfig(aliasSchema)
	aliasConfig!: InferConfig<typeof aliasSchema>
}
