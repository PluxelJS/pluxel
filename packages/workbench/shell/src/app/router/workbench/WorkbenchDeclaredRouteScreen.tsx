import { Stack, Text } from '@mantine/core'
import {
	getWorkbenchDirectoryConflicts,
	resolveWorkbenchDirectoryRoute,
} from '../../../workbench/route-directory'
import { useWorkbenchTargetSnapshot } from '../../../workbench/runtime'
import { WorkbenchRouteConflictList } from '../../workbench/shell/WorkbenchRouteConflicts'
import { NotFoundScreen } from '../screens/NotFoundScreen'
import { WorkbenchRouteStateFallback } from './WorkbenchRouteStatus'
import { WorkbenchRouteRenderer } from './WorkbenchRouteRenderer'
import { useMemo } from 'react'

/** A declared URL is resolved only after the complete route directory is available. */
export function WorkbenchDeclaredRouteScreen({ pathname }: { pathname: string }) {
	const snapshot = useWorkbenchTargetSnapshot(null)
	const route = useMemo(
		() => resolveWorkbenchDirectoryRoute(snapshot.directory, pathname),
		[snapshot.directory, pathname],
	)
	if (!snapshot.layout) {
		return <WorkbenchRouteStateFallback displayName="Workbench 路由" snapshot={snapshot} />
	}
	if (route) {
		return (
			<WorkbenchRouteRenderer
				target={route.entry.target.node}
				displayName={route.entry.target.displayName}
				displayPath={pathname}
				route={route}
				snapshot={snapshot}
			/>
		)
	}
	const conflicts = getWorkbenchDirectoryConflicts(snapshot.directory, pathname)
	if (conflicts.length > 0) {
		return (
			<Stack p="md" gap="md" style={{ overflowY: 'auto' }}>
				<Text fw={600}>这个路径有多个注册来源</Text>
				<Text size="sm" c="dimmed">
					{pathname} 对应多个页面，请选择：
				</Text>
				<WorkbenchRouteConflictList routes={conflicts} pathname={pathname} />
			</Stack>
		)
	}
	return <NotFoundScreen pathname={pathname} />
}
