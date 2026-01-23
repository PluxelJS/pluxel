import { describe, expect, it } from 'bun:test'
import { BasePlugin, getPluginInfo, Plugin } from '@pluxel/core'
import { v } from '../src/config'
import { Config } from '../src/index'

describe('Config decorator', () => {
	it('rejects non-object schema', () => {
		expect(() => Config(v.string() as unknown as never)).toThrow(
			'传入 Config 装饰器的必须是 valibot ObjectSchema',
		)
	})

	it('collects schema from decorated plugin', () => {
		const TestSchema = v.object({ test1: v.string() })

		@Plugin({ name: 'ConfigDecoratorTest' })
		class ConfigDecoratorTest extends BasePlugin {
			@Config(TestSchema)
			declare test1: unknown
		}

		const info = getPluginInfo(ConfigDecoratorTest)
		expect(info?.configMap).toBeDefined()
		expect(Object.keys(info?.configMap ?? {})).toContain('test1')
	})
})
