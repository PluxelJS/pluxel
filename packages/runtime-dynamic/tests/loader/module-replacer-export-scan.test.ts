import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin } from '@pluxel/runtime'

import { withTestDynamicContext } from '../support/context'

@Plugin({ name: 'NonEnumerableExportPlugin' })
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
			const result = await ctx.loader.replaceModule(moduleId, mod)

			expect(result.isAnchor).toBe(true)
			expect(ctx.loader.api.anchors.has(moduleId)).toBe(true)
			expect(ctx.loader.api.registry.findModuleId('NonEnumerableExportPlugin')).toBe(moduleId)
			expect(ctx.loader.api.registry.getExportKey('NonEnumerableExportPlugin')).toBe(
				'NonEnumerableExportPlugin',
			)
		})
	})
})
