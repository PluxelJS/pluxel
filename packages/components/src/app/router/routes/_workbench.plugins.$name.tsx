import { Outlet, createFileRoute, useParams } from '@tanstack/react-router'
import { Plugin } from '../../plugins/Plugin'
import { validatePluginDetailSearch } from '../index'

function PluginDetailRoute() {
	const { name: rawName } = useParams({ strict: false })
	let pluginName = rawName
	try {
		pluginName = decodeURIComponent(rawName)
	} catch {
		pluginName = rawName
	}

	return (
		<>
			<Plugin pluginName={pluginName} />
			<div style={{ display: 'none' }}>
				<Outlet />
			</div>
		</>
	)
}

export const Route = createFileRoute('/_workbench/plugins/$name')({
	validateSearch: validatePluginDetailSearch,
	component: PluginDetailRoute,
})
