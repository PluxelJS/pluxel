import { Alert, Loader, MantineProvider, Stack, Text } from '@mantine/core'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import type { WorkbenchView } from '@pluxel/runtime/workbench'
import type { RemoteValueSnapshot } from '@pluxel/runtime/workbench/client'
import {
	useRemoteValue,
	useWorkbench,
	type WorkbenchHostFacade,
} from '@pluxel/runtime/workbench/react'
import type { ReactNode } from 'react'
import type { PluginWithUIApi, PluginWithUISnapshot } from '../../PluginWithUI.workbench'

type DemoDescriptor = WorkbenchView<PluginWithUIApi>
type DemoView = Readonly<{
	api: RpcStub<PluginWithUIApi>
	host: WorkbenchHostFacade
	snapshot: RemoteValueSnapshot<PluginWithUISnapshot>
}>

export function useDemoView(descriptor: DemoDescriptor): DemoView {
	const { api, host } = useWorkbench(descriptor)
	const snapshot = useRemoteValue<PluginWithUISnapshot>(
		{
			read: async () => {
				const raw = await api.snapshot()
				try {
					return Object.freeze({
						revision: raw.revision,
						pluginName: raw.pluginName,
						startedAt: raw.startedAt,
						counter: raw.counter,
						events: Object.freeze(
							raw.events.map((event) =>
								Object.freeze({
									id: event.id,
									kind: event.kind,
									message: event.message,
									at: event.at,
								}),
							),
						),
					})
				} finally {
					dispose(raw)
				}
			},
			subscribe: (invalidate) => api.watch(() => invalidate()),
		},
		[api],
	)
	return { api, host, snapshot }
}

export async function runMutation(run: () => PromiseLike<unknown>): Promise<void> {
	const result = await run()
	dispose(result)
}

export function DemoSnapshot({
	state,
	children,
}: {
	state: RemoteValueSnapshot<PluginWithUISnapshot>
	children(snapshot: PluginWithUISnapshot): ReactNode
}) {
	if (state.state === 'loading') return <Loader size="sm" />
	if (state.state === 'error') {
		return (
			<Alert color="red">{state.error instanceof Error ? state.error.message : '加载失败'}</Alert>
		)
	}
	return <Stack gap="sm">{children(state.value)}</Stack>
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

function dispose(value: unknown): void {
	const action =
		value && (typeof value === 'object' || typeof value === 'function')
			? (value as Partial<Disposable>)[Symbol.dispose]
			: undefined
	if (typeof action === 'function') action.call(value)
}
