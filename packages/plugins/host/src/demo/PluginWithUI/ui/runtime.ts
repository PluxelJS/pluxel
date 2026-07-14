// Browser entry for the custom UI demo.
import { createWorkbenchUi, useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import type { PluginWithUIWorkbench } from '../../PluginWithUI.workbench'

export const plugin = createWorkbenchUi<typeof PluginWithUIWorkbench>()
const contentViews = plugin.view(
	'OverviewPanel',
	'EventsPanel',
	'StreamsPanel',
	'PluginInfo',
	'DashboardRoute',
	'NotesRoute',
	'StandaloneRoute',
)

export function usePluginWithUi() {
	return { model: contentViews.useModel(), ...useWorkbenchHost() }
}

export type PluginWithUIRuntime = ReturnType<typeof usePluginWithUi>
