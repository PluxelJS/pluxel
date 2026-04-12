// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { ExtensionPoints, type PluginUIModule } from '../../src/web/ui'

function routePaths(module: PluginUIModule) {
	return (module.routes ?? []).map((route) => route.definition.path)
}

function extensionIds(module: PluginUIModule) {
	return (module.extensions ?? []).map((extension) => extension.id)
}

type DemoModules = {
	pluginWithUi: PluginUIModule
	fontPickerUi: PluginUIModule
	statusBadgeUi: PluginUIModule
}

async function loadDemoModules(): Promise<DemoModules> {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
		const [{ default: pluginWithUi }, { default: fontPickerUi }, { default: statusBadgeUi }] =
			await Promise.all([
				import('../../../plugins/host/src/demo/PluginWithUI/ui/index'),
				import('../../../plugins/host/src/demo/PluginContributionFontDemo/ui/index'),
				import('../ui-demos/PluginStatusBadge/ui/StatusBadge'),
			])
		return {
			pluginWithUi,
			fontPickerUi,
			statusBadgeUi,
		}
	} finally {
		warn.mockRestore()
	}
}

describe('demo plugin UI contract', () => {
	it('keeps demo modules on the stable definePluginUIModule surface', async () => {
		const { pluginWithUi, fontPickerUi, statusBadgeUi } = await loadDemoModules()
		const modules: Array<[name: string, module: PluginUIModule]> = [
			['PluginWithUI', pluginWithUi],
			['PluginContributionFontDemo', fontPickerUi],
			['PluginStatusBadge', statusBadgeUi],
		]

		for (const [name, module] of modules) {
			expect(module).toBeTruthy()
			expect(new Set(extensionIds(module)).size, `${name} extension ids should stay unique`).toBe(
				extensionIds(module).length,
			)
			expect(new Set(routePaths(module)).size, `${name} route paths should stay unique`).toBe(
				routePaths(module).length,
			)
		}
	}, 15_000)

	it('preserves the key host demo affordances', async () => {
		const { pluginWithUi, fontPickerUi, statusBadgeUi } = await loadDemoModules()
		expect(
			pluginWithUi.extensions?.some((ext) => ext.point === ExtensionPoints.HeaderActions),
		).toBe(true)
		expect(pluginWithUi.extensions?.some((ext) => ext.point === ExtensionPoints.PluginInfo)).toBe(
			true,
		)
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

		expect(Object.keys(fontPickerUi.sessions ?? {})).toEqual(['fontPickerSession'])
		expect(
			statusBadgeUi.extensions?.every((ext) => ext.point === ExtensionPoints.HeaderActions),
		).toBe(true)
	})
})
