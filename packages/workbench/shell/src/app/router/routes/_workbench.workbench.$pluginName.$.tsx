import { createFileRoute } from '@tanstack/react-router'
import { WORKBENCH_ROUTE_PREFIX } from '../../../workbench/paths'
import { WorkbenchRouteScreen } from '../workbench/WorkbenchRouteScreen'

export const Route = createFileRoute('/_workbench/workbench/$pluginName/$')({
	beforeLoad: ({ location }) => ({ pathname: location.pathname }),
	component: WorkbenchPluginRoute,
})

function WorkbenchPluginRoute() {
	const { pathname } = Route.useRouteContext()
	return <WorkbenchRouteScreen prefix={WORKBENCH_ROUTE_PREFIX} pathname={pathname} />
}
