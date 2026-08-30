import { Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core'
import { useState } from 'react'
import { PluginWithUIWorkbench } from '../../PluginWithUI.workbench'
import { DemoIdentity, DemoProvider, DemoSnapshot, runMutation, useDemoView } from './shared'

export default function Events() {
	const { api, host, snapshot } = useDemoView(PluginWithUIWorkbench.events)
	const [message, setMessage] = useState('')
	const add = async () => {
		const value = message.trim()
		if (!value) return
		await runMutation(() => api.addNote(value))
		setMessage('')
	}
	return (
		<DemoProvider host={host}>
			<Stack gap="md">
				<Title order={4}>插件事件</Title>
				<DemoIdentity />
				<Group align="end">
					<TextInput
						label="新事件"
						value={message}
						onChange={(event) => setMessage(event.currentTarget.value)}
					/>
					<Button onClick={() => void add()}>添加</Button>
					<Button
						color="red"
						variant="light"
						onClick={() => void runMutation(() => api.clearEvents())}
					>
						清空
					</Button>
				</Group>
				<DemoSnapshot state={snapshot}>
					{(value) => (
						<Stack gap="xs">
							{value.events.toReversed().map((event) => (
								<Card key={event.id} withBorder p="sm">
									<Text size="xs" c="dimmed">
										{event.kind} · {new Date(event.at).toLocaleTimeString()}
									</Text>
									<Text size="sm">{event.message}</Text>
								</Card>
							))}
						</Stack>
					)}
				</DemoSnapshot>
			</Stack>
		</DemoProvider>
	)
}
