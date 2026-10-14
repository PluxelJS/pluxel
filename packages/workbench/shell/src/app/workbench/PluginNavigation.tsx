import { formatPluginNodeRoute } from '@pluxel/core'
import { useWorkbenchState } from '@worksplit/react'
import { useSyncExternalStore } from 'react'
import { PluginCatalog } from '../plugins/catalog/PluginCatalog'
import { useWorkspaceSession } from './workspaceContext'

export function PluginNavigation() {
	const session = useWorkspaceSession()
	const activeId = useWorkbenchState(session.workbench, (state) => state.activeDocumentId)
	useSyncExternalStore(session.subscribeContentState, session.getContentRevision)
	const owner = activeId ? session.documents.get(activeId)?.plugin : undefined
	return (
		<div className="plx-pluginCatalogPage">
			<PluginCatalog activeId={owner ? formatPluginNodeRoute(owner) : undefined} />
		</div>
	)
}
