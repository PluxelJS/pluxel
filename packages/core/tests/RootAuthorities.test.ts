import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import { createCoreInternalTestHost, withCoreInternalTestContext } from '@pluxel/core/internal/test'
import { createOwnerContext } from '../src/context/context-factory'
import type { RootContext } from '@pluxel/core'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('root host authorities', () => {
	it('keeps mutable PluginService authority off the normal test host', async () => {
		const host = createCoreInternalTestHost()
		try {
			expectTypeOf(host.ctx).toEqualTypeOf<RootContext>()
			expect('registry' in host).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('ignores child service spoofs and keeps service ownership on the root Context', async () => {
		await withCoreInternalTestContext(async (root) => {
			expectTypeOf(root).toEqualTypeOf<RootContext>()
			const registry = requirePluginService(root)
			const configService = requireConfigService(root)
			const child = createOwnerContext(root, 'spoofed-child')
			const spoofRegistry = { beginUpdate() {}, getInstance() {} }
			const spoofConfigService = { getRawConfig() {}, ensureValidated() {}, patchConfig() {} }
			Object.defineProperties(child, {
				registry: { value: spoofRegistry, configurable: true },
				configService: { value: spoofConfigService, configurable: true },
			})

			expect((child as unknown as { registry: unknown }).registry).toBe(spoofRegistry)
			expect((child as unknown as { configService: unknown }).configService).toBe(
				spoofConfigService,
			)
			expect(requirePluginService(child)).toBe(registry)
			expect(requireConfigService(child)).toBe(configService)
			expect(registry.ctx).toBe(root)
			expect(configService.ctx).toBe(root)
		})
	})
})
