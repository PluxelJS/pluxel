import { formatPluginNodeRoute } from '@pluxel/core'
import { useWorkbenchState } from '@worksplit/react'
import { useSyncExternalStore } from 'react'
import { PluginRegionTabs } from './PluginPanels'
import { WorkspaceNavigation } from './WorkspaceNavigation'
import { useWorkspaceSession } from './workspaceContext'

export function PluginNavigation() {
	const session = useWorkspaceSession()
	const activeId = useWorkbenchState(session.workbench, (state) => state.activeDocumentId)
	useSyncExternalStore(session.subscribeContentState, session.getContentRevision)
	const owner = activeId ? session.documents.get(activeId)?.plugin : undefined
	return (
		<PluginRegionTabs
			region="left"
			keepBuiltinMounted
			builtins={(session.activeWorkspace() === 'plugins' ? (['plugins'] as const) : []).map(
				(mode) => ({
					value: mode,
					label: '插件目录',
					content: (
						<WorkspaceNavigation
							mode={mode}
							activePluginRoute={owner ? formatPluginNodeRoute(owner) : undefined}
							activeEntryKey={activeId ? session.documents.get(activeId)?.pluginEntry : undefined}
						/>
					),
				}),
			)}
		/>
	)
}
