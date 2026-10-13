import { createFileRoute } from '@tanstack/react-router'
import { PluginCatalog } from '../../plugins/catalog/PluginCatalog'
import { useDocumentWorkspace } from '../../workbench/document'

function PluginsIndexRoute() {
	useDocumentWorkspace('plugins')
	return (
		<div className="plx-pluginCatalogPage">
			<PluginCatalog />
		</div>
	)
}

export const Route = createFileRoute('/_workbench/plugins/')({
	staticData: { worksplit: { title: '插件' } },
	component: PluginsIndexRoute,
})
