import { createFileRoute, useMatch } from '@tanstack/react-router'
import { WorkbenchShell } from '../../workbench/WorkbenchShell'
import { useWorkbenchTargetSnapshot } from '../../../workbench/runtime'
import { resolveWorkbenchDirectoryRoute } from '../../../workbench/route-directory'
import { useCurrentPathname } from '../useCurrentRoute'
import { WorkbenchDeclaredRouteScreen } from '../workbench/WorkbenchDeclaredRouteScreen'
import { WorkbenchRouteStateFallback } from '../workbench/WorkbenchRouteStatus'

export const Route = createFileRoute('/_workbench')({ component: WorkbenchFrame })

function WorkbenchFrame() {
	const pathname = useCurrentPathname()
	const declared = useMatch({ from: '/_workbench/$', shouldThrow: false })
	const snapshot = useWorkbenchTargetSnapshot(null)
	if (declared) {
		if (!snapshot.layout) {
			return <WorkbenchRouteStateFallback displayName="Workbench 路由" snapshot={snapshot} />
		}
		const route = resolveWorkbenchDirectoryRoute(snapshot.directory, pathname)
		if (route?.frame === 'standalone') return <WorkbenchDeclaredRouteScreen pathname={pathname} />
	}
	return <WorkbenchShell />
}
