import { createFileRoute } from '@tanstack/react-router'
import { WORKBENCH_STANDALONE_ROUTE_PREFIX } from '../../../workbench/paths'
import { WorkbenchRouteScreen } from '../workbench/WorkbenchRouteScreen'

export const Route = createFileRoute('/_standalone/workbench-standalone/$pluginName/$')({
	beforeLoad: ({ location }) => ({ pathname: location.pathname }),
	component: WorkbenchPluginRoute,
})

function WorkbenchPluginRoute() {
	const { pathname } = Route.useRouteContext()
	return <WorkbenchRouteScreen prefix={WORKBENCH_STANDALONE_ROUTE_PREFIX} pathname={pathname} />
}
