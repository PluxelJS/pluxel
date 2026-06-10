import { describe, expect, test } from 'vitest'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { __registerConfigSchema__ as registerUnsafeConfigSchema } from '@pluxel/test/unsafe'
import * as v from 'valibot'
import { PluginRegistry } from '../../../runtime-dynamic/src/loader/PluginRegistry'

@Plugin({ name: 'BadConfigPlugin' })
class BadConfigPlugin extends BasePlugin {
	bad = this.configs.use(v.optional(v.string()))
}

describe('PluginRegistry config schema enforcement', () => {
	test('throws when a plugin declares non-object config schema', () => {
		registerUnsafeConfigSchema(BadConfigPlugin, 'bad', v.optional(v.string()))

		const registry = new PluginRegistry({ configService: { getExtra: () => ({}) } } as any)
		expect(() => registry.getSchema(BadConfigPlugin as any)).toThrow(
			/Invalid config schema: "BadConfigPlugin\.bad"/,
		)
	})
})
