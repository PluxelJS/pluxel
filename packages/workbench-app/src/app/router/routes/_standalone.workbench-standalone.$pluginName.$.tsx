import { createFileRoute } from '@tanstack/react-router'
import { WORKBENCH_STANDALONE_ROUTE_PREFIX } from '../../../workbench/paths'
import { WorkbenchRouteScreen } from '../workbench/WorkbenchRouteScreen'

export const Route = createFileRoute('/_standalone/workbench-standalone/$pluginName/$')({
	component: () => <WorkbenchRouteScreen prefix={WORKBENCH_STANDALONE_ROUTE_PREFIX} />,
})
