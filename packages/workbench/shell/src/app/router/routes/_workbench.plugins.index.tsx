import { createFileRoute } from '@tanstack/react-router'
import { PluginCatalog } from '../../plugins/catalog/PluginCatalog'

function PluginsIndexRoute() {
	return (
		<div className="plx-pluginCatalogPage">
			<PluginCatalog />
		</div>
	)
}

export const Route = createFileRoute('/_workbench/plugins/')({
	component: PluginsIndexRoute,
})
