import { Button, Card, Code, Group, Stack, Text, Title } from '@mantine/core'
import { PluginWithUIWorkbench } from '../../PluginWithUI.workbench'
import { DemoIdentity, DemoSnapshot, runMutation, useDemoView } from './shared'

export default function Overview() {
	const { api, host, snapshot } = useDemoView(PluginWithUIWorkbench.overview)
	return (
		<Stack gap="md">
			<Title order={4}>PluginWithUI 概览</Title>
			<DemoIdentity />
			<DemoSnapshot state={snapshot}>
				{(value) => (
					<>
						<Card withBorder>
							<Text size="sm">
								插件：<Code>{value.pluginName}</Code>
							</Text>
							<Text size="sm">
								计数器：<Code>{value.counter}</Code>
							</Text>
							<Text size="sm">
								事件数：<Code>{value.events.length}</Code>
							</Text>
						</Card>
						<Group>
							<Button onClick={() => void runMutation(() => api.increment(1))}>+1</Button>
							<Button variant="light" onClick={() => void runMutation(() => api.resetCounter())}>
								重置
							</Button>
							<Button variant="subtle" onClick={() => host.navigation?.navigate('/dashboard')}>
								Dashboard
							</Button>
						</Group>
					</>
				)}
			</DemoSnapshot>
		</Stack>
	)
}
