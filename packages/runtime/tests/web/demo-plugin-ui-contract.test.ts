// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { ExtensionPoints, type PluginUIModule } from '../../src/web/ui'

function expectUnique(values: string[], label: string) {
	expect(new Set(values).size, `${label} should stay unique`).toBe(values.length)
}

function routePaths(module: PluginUIModule) {
	return (module.routes ?? []).map((route) => route.definition.path)
}

function extensionIds(module: PluginUIModule) {
	return (module.extensions ?? []).map((extension) => extension.id)
}

type DemoModules = {
	pluginWithUi: PluginUIModule
	marketUi: PluginUIModule
	snapshotUi: PluginUIModule
	statusBadgeUi: PluginUIModule
}

async function loadDemoModules(): Promise<DemoModules> {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		const [
			{ default: pluginWithUi },
			{ default: marketUi },
			{ default: snapshotUi },
			{ default: statusBadgeUi },
		] = await Promise.all([
			import('../../../plugins/host/src/demo/PluginWithUI/ui/index'),
			import('../../../plugins/market/src/ui/index'),
			import('../../../plugins/snapshot/src/ui/index'),
			import('../ui-demos/PluginStatusBadge/ui/StatusBadge'),
		])
		return {
			pluginWithUi,
			marketUi,
			snapshotUi,
			statusBadgeUi,
		}
	} finally {
		warn.mockRestore()
	}
}

describe('demo plugin UI contract', () => {
	it(
		'keeps demo modules on the stable definePluginUIModule surface',
		async () => {
		const { pluginWithUi, marketUi, snapshotUi, statusBadgeUi } = await loadDemoModules()
		const modules: Array<[name: string, module: PluginUIModule]> = [
			['PluginWithUI', pluginWithUi],
			['MarketUI', marketUi],
			['Snapshot', snapshotUi],
			['PluginStatusBadge', statusBadgeUi],
		]

		for (const [name, module] of modules) {
			expect(module).toBeTruthy()
			expectUnique(extensionIds(module), `${name} extension ids`)
			expectUnique(routePaths(module), `${name} route paths`)
		}
		},
		15_000,
	)

	it('preserves the key host demo affordances', async () => {
		const { pluginWithUi, marketUi, snapshotUi, statusBadgeUi } = await loadDemoModules()
		expect(pluginWithUi.extensions?.some((ext) => ext.point === ExtensionPoints.GlobalStatusBar)).toBe(
			true,
		)
		expect(pluginWithUi.extensions?.some((ext) => ext.point === ExtensionPoints.PluginInfo)).toBe(true)
		expect(
			pluginWithUi.extensions?.some(
				(ext) => ext.point === ExtensionPoints.PluginInfo && ext.requireRunning === true,
			),
		).toBe(true)
		expect(routePaths(pluginWithUi)).toEqual(['/dashboard', '/notes', '/standalone'])

		const standaloneRoute = pluginWithUi.routes?.find(
			(route) => route.definition.path === '/standalone',
		)?.definition
		expect(standaloneRoute?.path).toBe('/standalone')
		expect(standaloneRoute?.frame).toBe('standalone')
		expect(standaloneRoute?.addToNav).toBe(true)

		expect(routePaths(marketUi)).toEqual(['/market'])
		expect(
			snapshotUi.extensions?.every((ext) => ext.point === ExtensionPoints.HeaderActions),
		).toBe(true)
		expect(
			statusBadgeUi.extensions?.every((ext) => ext.point === ExtensionPoints.HeaderActions),
		).toBe(true)
	})
})
