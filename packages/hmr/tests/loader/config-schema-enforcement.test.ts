import { describe, expect, test } from 'bun:test'
import { BasePlugin, Config, Plugin } from '@pluxel/core'
import * as v from 'valibot'
import { PluginRegistry } from '../../src/services/loader/PluginRegistry'

describe('PluginRegistry config schema enforcement', () => {
	test('throws when a plugin declares non-object config schema', () => {
		@Plugin({ name: 'BadConfigPlugin' })
		class BadConfigPlugin extends BasePlugin {
			@Config(v.optional(v.string()))
			bad?: string
		}

		const registry = new PluginRegistry({ configService: { getExtra: () => ({}) } } as any)
		expect(() => registry.getSchema(BadConfigPlugin as any)).toThrow(
			/Invalid config schema: "BadConfigPlugin\.bad"/,
		)
	})
})

