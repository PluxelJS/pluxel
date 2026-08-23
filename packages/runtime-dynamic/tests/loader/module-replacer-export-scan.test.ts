import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/runtime'

import { requireLoaderService } from '../../src/context-plan'
import { withTestDynamicContext } from '../support/context'

@Plugin({ displayName: 'Non-enumerable export Plugin' })
class NonEnumerableExportPlugin extends BasePlugin {}

describe('ModuleReplacer export scanning', () => {
	it('detects plugin exports even when export keys are non-enumerable', async () => {
		await withTestDynamicContext(async (ctx) => {
			const mod: Record<string, unknown> = {}
			Object.defineProperty(mod, 'NonEnumerableExportPlugin', {
				value: NonEnumerableExportPlugin,
				enumerable: false,
				configurable: true,
			})

			const moduleId = '/repo/non-enum.ts'
			const result = await requireLoaderService(ctx).replaceModule(moduleId, mod)
			const address = pluginNodeAddressOf(NonEnumerableExportPlugin)

			expect(result.isAnchor).toBe(true)
			expect(requireLoaderService(ctx).api.anchors.has(moduleId)).toBe(true)
			expect(requireLoaderService(ctx).api.registry.findModuleId(address)).toBe(moduleId)
			expect(requireLoaderService(ctx).api.registry.getExportKey(address)).toBe(
				'NonEnumerableExportPlugin',
			)
		})
	})
})
