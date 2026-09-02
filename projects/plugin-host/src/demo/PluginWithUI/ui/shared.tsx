import { Alert, Loader, MantineProvider, Stack, Text } from '@mantine/core'
import type { WorkbenchHostFacade } from '@pluxel/runtime/workbench/react'
import type { ReactNode } from 'react'
import type { PluginWithUISnapshot } from '../../PluginWithUI.workbench'

export function DemoSnapshot({
	pending,
	data,
	error,
	children,
}: {
	pending: boolean
	data: PluginWithUISnapshot | undefined
	error: unknown | null
	children(snapshot: PluginWithUISnapshot): ReactNode
}) {
	if (pending && data === undefined) return <Loader size="sm" />
	if (data === undefined) return <Alert color="red">{messageOf(error)}</Alert>
	return (
		<Stack gap="sm">
			{error === null || error === undefined ? null : <Alert color="red">{messageOf(error)}</Alert>}
			{children(data)}
		</Stack>
	)
}

export function DemoIdentity() {
	return (
		<Text size="xs" c="dimmed">
			Direct View API · Cap’n Web observer · no platform collection
		</Text>
	)
}

export function DemoProvider({
	host,
	children,
}: Readonly<{ host: WorkbenchHostFacade; children: ReactNode }>) {
	return <MantineProvider forceColorScheme={host.colorScheme}>{children}</MantineProvider>
}

function messageOf(error: unknown): string {
	if (error === null || error === undefined) return '加载失败'
	return error instanceof Error ? error.message : String(error)
}
