import { Button, Card, Stack, Text, Title } from '@mantine/core'
import { useEffect } from 'react'
import type { WorkbenchHostFacade } from '@pluxel/runtime/workbench/react'
import { dashboardScope, dashboardSnapshot } from './dashboard.scope'
import { DemoIdentity, DemoProvider, DemoSnapshot } from './shared'

function Dashboard() {
	const { host } = dashboardScope.useWorkbench()
	return (
		<DemoProvider host={host}>
			<DashboardContent host={host} />
		</DemoProvider>
	)
}

function DashboardContent({ host }: Readonly<{ host: WorkbenchHostFacade }>) {
	const snapshotQuery = dashboardSnapshot.useQuery()
	useEffect(() => {
		host.document?.setTitle({ title: 'UI Demo Dashboard', meta: 'Direct View' })
	}, [host])

	return (
		<Stack gap="md">
			<Title order={3}>Dashboard</Title>
			<DemoIdentity />
			<DemoSnapshot
				pending={snapshotQuery.status === 'pending'}
				data={snapshotQuery.data}
				error={snapshotQuery.error}
			>
				{(value) => (
					<Card withBorder>
						revision {value.revision} · counter {value.counter}
					</Card>
				)}
			</DemoSnapshot>
			<Button variant="light" onClick={() => host.navigation?.navigate('/dashboard')}>
				刷新当前文档
			</Button>
			<Text size="xs" c="dimmed">
				route params 由服务端 openEntry 再匹配。
			</Text>
		</Stack>
	)
}

export default dashboardScope.render(Dashboard)
