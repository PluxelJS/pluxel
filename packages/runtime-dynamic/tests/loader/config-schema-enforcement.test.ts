import { describe, expect, test } from 'vitest'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { __registerConfigSchema__ as registerUnsafeConfigSchema } from '@pluxel/test/unsafe'
import * as v from 'valibot'

import { withTestDynamicContext } from '../support/context'

@Plugin({ name: 'BadConfigPlugin' })
class BadConfigPlugin extends BasePlugin {
	bad = this.configs.use(v.optional(v.string()))
}

describe('PluginRegistry config schema enforcement', () => {
	test('throws when a plugin declares non-object config schema', async () => {
		registerUnsafeConfigSchema(BadConfigPlugin, 'bad', v.optional(v.string()))

		await withTestDynamicContext((ctx) => {
			expect(() => ctx.loader.api.registry.getSchema(BadConfigPlugin)).toThrow(
				/Invalid config schema: "BadConfigPlugin\.bad"/,
			)
		})
	})
})
