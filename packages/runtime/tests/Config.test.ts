import { describe, expect, it } from 'vitest'
import { BasePlugin, getPluginInfo, Plugin } from '@pluxel/runtime/test'
import { v } from '../src/config'

const TestSchema = v.object({ test1: v.string() })

@Plugin({ displayName: 'Config schema test' })
class ConfigSchemaTestPlugin extends BasePlugin {
	readonly config = this.configs.use(TestSchema)
}

describe('single Plugin config schema', () => {
	it('lowers one configs.use object schema into Plugin facts', () => {
		const info = getPluginInfo(ConfigSchemaTestPlugin)
		expect(info.config?.fieldName).toBe('config')
		expect(info.config?.schema).toBe(TestSchema)
	})
})
