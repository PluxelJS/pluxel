import { pluginNodeAddressOf } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { createRuntimeInternalTestHarness } from '@pluxel/runtime/internal/test'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeManagementTargetImpl } from '../../src/services/management/RuntimeManagementTarget'
import { parsePluginCatalogSnapshot } from '../../src/web/management-validation'

@Plugin()
class Documents extends BasePlugin {}
@Plugin({ displayName: '业务报告' })
class Reports extends BasePlugin {
	constructor(readonly documents: Documents) {
		super()
	}
}
@Plugin()
class Independent extends BasePlugin {}

describe('committed Management catalog groups', () => {
	it('projects declared dependencies even while stopped, without interning slots, and accepts named layout/reset RPC', async () => {
		const host = createRuntimeInternalTestHarness({
			workbench: false,
			management: true,
			persistence: { mode: 'memory' },
		})
		try {
			host.add([Documents, Reports, Independent])
			await host.commit()
			const registry = requirePluginService(host.ctx)
			const intern = vi.spyOn(registry, 'internNodeAddress')
			const target = new RuntimeManagementTargetImpl(host.ctx)
			const snapshot = parsePluginCatalogSnapshot(await target.pluginCatalog())
			expect(intern).not.toHaveBeenCalled()
			expect(snapshot.summary).toMatchObject({ total: 3, running: 0 })
			expect(snapshot.sections).toHaveLength(1)
			expect(snapshot.sections[0]).toMatchObject({
				name: '业务报告',
				basis: { kind: 'dependency' },
			})
			expect(snapshot.sections[0]!.nodes).toContainEqual(pluginNodeAddressOf(Reports))
			expect(snapshot.sections[0]!.nodes).toContainEqual(pluginNodeAddressOf(Documents))
			const saved = await target.updatePluginCatalogLayout({
				sections: [
					{
						sectionId: 'manual:business',
						name: '业务',
						nodes: snapshot.plugins.map((plugin) => plugin.address),
					},
				],
			})
			expect(saved).toMatchObject({
				ok: true,
				sections: [{ name: '业务', basis: { kind: 'manual' } }],
			})
			await expect(
				target.updatePluginCatalogLayout({ sections: [{ sectionId: 'manual:bad', nodes: [] }] }),
			).resolves.toMatchObject({ ok: false, code: 'invalid_input' })
			await expect(target.updatePluginCatalogLayout({ sections: null })).resolves.toEqual({
				ok: true,
				sections: snapshot.sections,
			})
		} finally {
			await host.dispose()
		}
	})
})
