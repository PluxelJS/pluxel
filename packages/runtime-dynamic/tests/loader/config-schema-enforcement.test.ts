import { describe, expect, test } from 'vitest'
import { pluginNodeAddressOf } from '@pluxel/core'
import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import { runtimeStatePatch } from '@pluxel/runtime/internal'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import * as v from 'valibot'

import { requireLoaderService } from '../../src/context-plan'
import { withTestDynamicContext } from '../support/context'

const ConfigSchema = v.object({ value: v.optional(v.string(), 'default') })

@Plugin({ displayName: 'Configured Plugin' })
class ConfiguredPlugin extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)
}

describe('coordinator catalog config schema enforcement', () => {
	test('publishes exactly one lowered object config definition', async () => {
		await withTestDynamicContext(async (ctx) => {
			await requireLoaderService(ctx).replaceModule('ConfiguredPlugin.ts', { ConfiguredPlugin })

			const config = requireLoaderService(ctx).api.registry.getConfig(
				pluginNodeAddressOf(ConfiguredPlugin),
			)
			expect(config).toMatchObject({ fieldName: 'config' })
			expect(config?.schema).toBe(ConfigSchema)
		})
	})

	test('commits the catalog while Core reports invalid config as a lifecycle issue', async () => {
		await withTestDynamicContext(async (ctx) => {
			const loader = requireLoaderService(ctx)
			const ownerAddress = pluginNodeAddressOf(ConfiguredPlugin)
			const registry = requirePluginService(ctx)
			requireConfigService(ctx).patchConfig(ownerAddress, { value: 42 })

			const batch = loader.beginBatch()
			await expect(
				batch.replaceModule('ConfiguredPlugin.ts', { ConfiguredPlugin }),
			).resolves.toMatchObject({ isAnchor: true })
			await expect(
				batch.commit({
					statePatch: runtimeStatePatch({
						type: 'set-enabled',
						node: ownerAddress,
						enabled: true,
					}),
				}),
			).resolves.toMatchObject({ core: { status: 'committed' } })
			const owner = registry.resolvePluginNode(ownerAddress)
			expect(owner).toBeDefined()

			expect(
				requireLoaderService(ctx).api.registry.getCtor(pluginNodeAddressOf(ConfiguredPlugin)),
			).toBe(ConfiguredPlugin)
			expect(registry.isRunning(ConfiguredPlugin)).toBe(false)
			expect(registry.lastCommit?.lifecycleReport.issues).toEqual([
				expect.objectContaining({
					plugin: owner,
					phase: 'config',
					kind: 'config-failed',
				}),
			])
		})
	})
})
