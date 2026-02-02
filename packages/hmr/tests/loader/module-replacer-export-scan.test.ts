import { describe, expect, it } from 'bun:test'
import type { Context } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { ModuleReplacer } from '../../src/services/runtime/loader/module-replacer'

@Plugin({ name: 'NonEnumerableExportPlugin' })
class NonEnumerableExportPlugin extends BasePlugin {}

describe('ModuleReplacer export scanning', () => {
	it('detects plugin exports even when export keys are non-enumerable', async () => {
		const declared: Array<{ moduleId: string; exportKey: string }> = []
		const anchors = new Set<string>()

		const ctx = {
			logger: { warn: () => undefined },
			configService: {
				isReady: true,
				ready: Promise.resolve(),
				isEnabledInConfig: () => false,
				getExtra: () => null,
			},
			registry: { container: null },
		} as unknown as Context

		const registry = {
			modules: new Map<string, Array<{ ctor: unknown }>>(),
			names: new Map<string, unknown>(),
			stopModule: () => undefined,
			undeclareModule: () => undefined,
			declarePlugin: (moduleId: string, _ctor: unknown, exportKey: string) => {
				declared.push({ moduleId, exportKey })
				return exportKey
			},
			syncRuntimeForModule: async () => undefined,
		} as any

		const replacer = new ModuleReplacer(
			ctx,
			registry,
			{
				add: (id: string) => anchors.add(id),
				delete: (id: string) => anchors.delete(id),
			} as any,
			() => undefined,
		)

		const mod: Record<string, unknown> = {}
		Object.defineProperty(mod, 'NonEnumerableExportPlugin', {
			value: NonEnumerableExportPlugin,
			enumerable: false,
			configurable: true,
		})

		const moduleId = '/repo/non-enum.ts'
		const isAnchor = await replacer.replaceModule(moduleId, mod)

		expect(isAnchor).toBe(true)
		expect(anchors.has(moduleId)).toBe(true)
		expect(declared).toEqual([{ moduleId, exportKey: 'NonEnumerableExportPlugin' }])
	})
})
