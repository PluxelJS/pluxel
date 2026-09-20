import { formatPluginNodeRoute } from '@pluxel/core'
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { PluginScreen } from '../../plugins/detail/PluginScreen'
import { validatePluginDetailSearch } from '../pluginDetailSearch'
import { parsePluginDetailHref } from '../../../workbench/paths'
import { useCurrentPathname } from '../useCurrentRoute'

function PluginDetailRoute() {
	const pathname = useCurrentPathname()
	const parsed = parsePluginDetailHref(pathname)
	const pluginRoute = parsed ? formatPluginNodeRoute(parsed.target) : ''

	return (
		<>
			<PluginScreen pluginRoute={pluginRoute} />
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
