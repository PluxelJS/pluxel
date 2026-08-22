import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import { createCoreHost, withCoreContext } from '@pluxel/core/test'
import { describe, expect, it } from 'vitest'

describe('root host authorities', () => {
	it('keeps mutable PluginService authority off the normal test host', async () => {
		const host = createCoreHost()
		try {
			expect('registry' in host).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('ignores child service spoofs and keeps service ownership on the root Context', async () => {
		await withCoreContext(async (root) => {
			const registry = requirePluginService(root)
			const configService = requireConfigService(root)
			const child = root.extend({ name: 'spoofed-child' })
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
