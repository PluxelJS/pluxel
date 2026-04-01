import { Outlet, createFileRoute, useParams } from '@tanstack/react-router'
import { PluginScreen } from '../../plugins/detail/PluginScreen'
import { validatePluginDetailSearch } from '../pluginDetailSearch'

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
			<PluginScreen pluginName={pluginName} />
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
