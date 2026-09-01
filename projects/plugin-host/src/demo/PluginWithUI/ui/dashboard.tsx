import { Button, Card, Stack, Text, Title } from '@mantine/core'
import { useEffect } from 'react'
import { PluginWithUIWorkbench } from '../../PluginWithUI.workbench'
import { DemoIdentity, DemoProvider, DemoSnapshot, useDemoView } from './shared'

export default function Dashboard() {
	const { host, snapshot } = useDemoView(PluginWithUIWorkbench.dashboard)
	useEffect(() => {
		host.document?.setTitle({ title: 'UI Demo Dashboard', meta: 'Direct View' })
	}, [host])
	return (
		<DemoProvider host={host}>
			<Stack gap="md">
				<Title order={3}>Dashboard</Title>
				<DemoIdentity />
				<DemoSnapshot state={snapshot}>
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
		</DemoProvider>
	)
}
