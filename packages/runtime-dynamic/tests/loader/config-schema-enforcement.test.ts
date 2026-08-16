import { describe, expect, test } from 'vitest'
import { pluginNodeAddressOf } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import * as v from 'valibot'

import { withTestDynamicContext } from '../support/context'
import { enablePlugins } from '../support/runtime-state'

const ConfigSchema = v.object({ value: v.optional(v.string(), 'default') })

@Plugin({ displayName: 'Configured Plugin' })
class ConfiguredPlugin extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)
}

describe('PluginRegistry config schema enforcement', () => {
	test('publishes exactly one lowered object config definition', async () => {
		await withTestDynamicContext(async (ctx) => {
			await ctx.loader.replaceModule('ConfiguredPlugin.ts', { ConfiguredPlugin })

			const config = ctx.loader.api.registry.getConfig(pluginNodeAddressOf(ConfiguredPlugin))
			expect(config).toMatchObject({ fieldName: 'config' })
			expect(config?.schema).toBe(ConfigSchema)
		})
	})

	test('commits the catalog while Core reports invalid config as a lifecycle issue', async () => {
		await withTestDynamicContext(async (ctx) => {
			enablePlugins(ctx, ConfiguredPlugin)
			const owner = ctx.registry.internNodeAddress(pluginNodeAddressOf(ConfiguredPlugin))
			ctx.configService.patchConfig(owner, { value: 42 })

			await expect(
				ctx.loader.replaceModule('ConfiguredPlugin.ts', { ConfiguredPlugin }),
			).resolves.toMatchObject({ isAnchor: true })

			expect(ctx.loader.api.registry.getCtor(pluginNodeAddressOf(ConfiguredPlugin))).toBe(
				ConfiguredPlugin,
			)
			expect(ctx.registry.isRunning(ConfiguredPlugin)).toBe(false)
			expect(ctx.registry.lastCommit?.lifecycleReport.issues).toEqual([
				expect.objectContaining({
					plugin: owner,
					phase: 'config',
					kind: 'config-failed',
				}),
			])
		})
	})
})
