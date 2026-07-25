import { createFileRoute } from '@tanstack/react-router'
import { WORKBENCH_ROUTE_PREFIX } from '../../../workbench/paths'
import { WorkbenchRouteScreen } from '../workbench/WorkbenchRouteScreen'

export const Route = createFileRoute('/_workbench/ext/$pluginName/$')({
	component: () => <WorkbenchRouteScreen prefix={WORKBENCH_ROUTE_PREFIX} />,
})
