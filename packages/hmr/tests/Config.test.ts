import { describe, expect, it } from 'bun:test'
import { getPluginInfo } from '@pluxel/core'
import { v } from '../src/config'
import { Config } from '../src/index'
import { PluginA } from './plugins'

describe('Config decorator', () => {
	it('rejects non-object schema', () => {
		expect(() => Config(v.string() as any)).toThrow(
			'传入 Config 装饰器的必须是 valibot ObjectSchema',
		)
	})

	it('collects schema from decorated plugin', () => {
		const info = getPluginInfo(PluginA)
		expect(info?.configMap).toBeDefined()
		expect(Object.keys(info?.configMap ?? {})).toContain('test1')
	})
})
