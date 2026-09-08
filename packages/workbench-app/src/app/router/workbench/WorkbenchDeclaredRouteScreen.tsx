import { Stack, Text } from '@mantine/core'
import {
	getWorkbenchDirectoryConflicts,
	resolveWorkbenchDirectoryRoute,
} from '../../../workbench/route-directory'
import { useWorkbenchTargetSnapshot, WorkbenchTargetProvider } from '../../../workbench/runtime'
import { WorkbenchRouteConflictList } from '../../workbench/shell/WorkbenchRouteConflicts'
import { NotFoundScreen } from '../screens/NotFoundScreen'
import { WorkbenchRouteStateFallback } from './WorkbenchRouteStatus'
import { WorkbenchRouteRenderer } from './WorkbenchRouteRenderer'

/** A declared URL is resolved only after the complete route directory is available. */
export function WorkbenchDeclaredRouteScreen({ pathname }: { pathname: string }) {
	const snapshot = useWorkbenchTargetSnapshot(null)
	if (!snapshot.layout) {
		return <WorkbenchRouteStateFallback displayName="Workbench 路由" snapshot={snapshot} />
	}
	const route = resolveWorkbenchDirectoryRoute(snapshot.directory, pathname)
	if (route) {
		return (
			<WorkbenchTargetProvider target={route.entry.target.node} pathname={pathname}>
				<WorkbenchRouteRenderer
					target={route.entry.target.node}
					displayName={route.entry.target.displayName}
					displayPath={pathname}
					pathname={pathname}
					route={route}
					snapshot={snapshot}
				/>
			</WorkbenchTargetProvider>
		)
	}
	const conflicts = getWorkbenchDirectoryConflicts(snapshot.directory, pathname)
	if (conflicts.length > 0) {
		return (
			<Stack p="md" gap="md" style={{ overflowY: 'auto' }}>
				<Text fw={600}>这个路径有多个注册来源</Text>
				<Text size="sm" c="dimmed">
					{pathname} 无法唯一定位页面，请使用下方完整链接。
				</Text>
				<WorkbenchRouteConflictList routes={conflicts} pathname={pathname} />
			</Stack>
		)
	}
	return <NotFoundScreen pathname={pathname} />
}
