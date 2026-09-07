import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { consumePluginDefinitionCandidate } from '@pluxel/test/unsafe'
import { v } from '../src/config'

const TestSchema = v.object({ test1: v.string() })

@Plugin({ displayName: 'Config schema test' })
class ConfigSchemaTestPlugin extends BasePlugin {
	readonly config = this.configs.use(TestSchema)
}

describe('single Plugin config schema', () => {
	it('lowers one configs.use object schema into Plugin facts', () => {
		const candidate = consumePluginDefinitionCandidate(ConfigSchemaTestPlugin)
		expect(candidate.declaration.config?.fieldName).toBe('config')
		expect(candidate.declaration.config?.schema).toBe(TestSchema)
	})
})
