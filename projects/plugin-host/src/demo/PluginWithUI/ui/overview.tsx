import { Alert, Button, Card, Code, Group, Stack, Text, Title } from '@mantine/core'
import type { WorkbenchHostFacade } from '@pluxel/runtime/workbench/react'
import { DemoIdentity, DemoProvider, DemoSnapshot } from './shared'
import { incrementCounter, overviewScope, overviewSnapshot, resetCounter } from './overview.scope'

function Overview() {
	const { host } = overviewScope.useWorkbench()
	return (
		<DemoProvider host={host}>
			<OverviewContent host={host} />
		</DemoProvider>
	)
}

function OverviewContent({ host }: Readonly<{ host: WorkbenchHostFacade }>) {
	const snapshotQuery = overviewSnapshot.useQuery()
	const incrementMutation = incrementCounter.useMutation()
	const resetMutation = resetCounter.useMutation()
	const busy = incrementMutation.isPending || resetMutation.isPending
	const mutationError =
		incrementMutation.status === 'error'
			? incrementMutation.error
			: resetMutation.status === 'error'
				? resetMutation.error
				: undefined

	return (
		<Stack gap="md">
			<Title order={4}>PluginWithUI 概览</Title>
			<DemoIdentity />
			{mutationError ? <Alert color="red">{messageOf(mutationError)}</Alert> : null}
			<DemoSnapshot
				pending={snapshotQuery.status === 'pending'}
				data={snapshotQuery.data}
				error={snapshotQuery.error}
			>
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
							<Button
								loading={incrementMutation.isPending}
								disabled={busy}
								onClick={() => {
									resetMutation.reset()
									incrementMutation.mutate(1)
								}}
							>
								+1
							</Button>
							<Button
								variant="light"
								loading={resetMutation.isPending}
								disabled={busy}
								onClick={() => {
									incrementMutation.reset()
									resetMutation.mutate()
								}}
							>
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

export default overviewScope.render(Overview)

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
