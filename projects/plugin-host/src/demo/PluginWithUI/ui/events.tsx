import { Alert, Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core'
import { useState } from 'react'
import { addNote, clearEvents, eventsScope, eventsSnapshot } from './events.scope'
import { DemoIdentity, DemoProvider, DemoSnapshot } from './shared'

function Events() {
	const { host } = eventsScope.useWorkbench()
	return (
		<DemoProvider host={host}>
			<EventsContent />
		</DemoProvider>
	)
}

function EventsContent() {
	const [message, setMessage] = useState('')
	const snapshotQuery = eventsSnapshot.useQuery()
	const addMutation = addNote.useMutation()
	const clearMutation = clearEvents.useMutation()
	const busy = addMutation.isPending || clearMutation.isPending
	const mutationError =
		addMutation.status === 'error'
			? addMutation.error
			: clearMutation.status === 'error'
				? clearMutation.error
				: undefined

	const add = async () => {
		const value = message.trim()
		if (!value) return
		clearMutation.reset()
		try {
			await addMutation.mutateAsync(value)
			setMessage('')
		} catch {
			// The mutation Hook owns the error state; this path only gates the success transition.
		}
	}

	return (
		<Stack gap="md">
			<Title order={4}>插件事件</Title>
			<DemoIdentity />
			{mutationError ? <Alert color="red">{messageOf(mutationError)}</Alert> : null}
			<Group align="end">
				<TextInput
					label="新事件"
					value={message}
					disabled={busy}
					onChange={(event) => setMessage(event.currentTarget.value)}
				/>
				<Button loading={addMutation.isPending} disabled={busy} onClick={() => void add()}>
					添加
				</Button>
				<Button
					color="red"
					variant="light"
					loading={clearMutation.isPending}
					disabled={busy}
					onClick={() => {
						addMutation.reset()
						clearMutation.mutate()
					}}
				>
					清空
				</Button>
			</Group>
			<DemoSnapshot
				pending={snapshotQuery.status === 'pending'}
				data={snapshotQuery.data}
				error={snapshotQuery.error}
			>
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
	)
}

export default eventsScope.render(Events)

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
