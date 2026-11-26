import { Alert, Button, Group, Paper, Stack, Text } from '@mantine/core'
import { pluginNodeAddressEqual, pluginNodeIndexKey } from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { useWorkbenchState } from '@worksplit/react'
import { useSyncExternalStore } from 'react'
import { useWorkbenchRuntime, useWorkbenchTargetSnapshot } from '../../workbench/runtime'
import type { WorkspaceSession } from './session'
import { useOptionalWorkspaceSession } from './workspaceContext'

export type PluginPanelEntry = WorkbenchLayoutEntry & {
	placement: Extract<WorkbenchLayoutEntry['placement'], { kind: 'panel' }>
}
export const panelRegionLabels = { left: '左侧', right: '右侧', bottom: '底部' } as const

/** Discovery uses the current publication, never cached declarations from a stopped owner. */
export function usePluginPanelDirectory(session: WorkspaceSession) {
	useWorkbenchState(session.workbench, (state) => state.revision)
	const activeId = useWorkbenchState(session.workbench, (state) => state.activeDocumentId)
	useSyncExternalStore(session.subscribeContentState, session.getContentRevision)
	const owner = activeId ? session.documents.get(activeId)?.plugin : undefined
	const snapshot = useWorkbenchTargetSnapshot(owner ?? null)
	const runtime = useWorkbenchRuntime()
	const running =
		!!owner &&
		(!runtime.runningPluginsReady || runtime.runningPluginKeys.has(pluginNodeIndexKey(owner)))
	const entries = owner
		? (snapshot.layout?.entries ?? [])
				.filter(
					(entry): entry is PluginPanelEntry =>
						entry.placement.kind === 'panel' && pluginNodeAddressEqual(entry.target.node, owner),
				)
				.toSorted(
					(a, b) =>
						a.placement.order - b.placement.order ||
						a.placement.label.localeCompare(b.placement.label),
				)
		: []
	return { owner, entries, running, snapshot, session }
}
export type PluginPanelDirectoryState = ReturnType<typeof usePluginPanelDirectory>

export function panelUnavailable(entry: PluginPanelEntry, running: boolean): string | undefined {
	if (!running) return '插件未运行'
	if (!('federatedViewUnavailable' in entry) || !entry.federatedViewUnavailable) return undefined
	return entry.federatedViewUnavailable.reason === 'building' ? '构建中' : '构建失败'
}

export function PluginPanelDirectory() {
	const session = useOptionalWorkspaceSession()
	return session ? <ConnectedDirectory session={session} /> : null
}
function ConnectedDirectory({ session }: { session: WorkspaceSession }) {
	const { owner, snapshot, entries, running } = usePluginPanelDirectory(session)
	if (!owner || (snapshot.state === 'ready' && !snapshot.error && entries.length === 0)) return null
	return (
		<Paper component="section" aria-label="插件扩展" withBorder p="xs" bg="var(--plx-raised)">
			<Stack gap={4}>
				<Text component="h2" size="sm" fw={600} m={0}>
					插件扩展
				</Text>
				{snapshot.error ? (
					<Alert color="red" title="扩展读取失败">
						{snapshot.error.message}
					</Alert>
				) : null}
				{snapshot.state === 'loading' ? (
					<Text size="xs" c="dimmed" role="status">
						正在读取扩展…
					</Text>
				) : null}
				{entries.map((entry) => {
					const unavailable = panelUnavailable(entry, running)
					const opened = session.isPanelOpen(entry)
					return (
						<Group key={entry.descriptor.key} justify="space-between" gap="xs" wrap="nowrap">
							<Group gap={6} style={{ minWidth: 0, flex: 1 }}>
								<Text size="sm" truncate="end" title={entry.placement.label} maw="100%">
									{entry.placement.label}
								</Text>
								<Text size="xs" c="dimmed">
									{panelRegionLabels[entry.placement.region]}
									{opened ? ' · 已打开' : ''}
								</Text>
							</Group>
							<Button
								size="compact-xs"
								variant="subtle"
								style={{ flexShrink: 0 }}
								disabled={!!unavailable}
								aria-label={`${unavailable ?? (opened ? '显示' : '打开')} ${entry.placement.label}`}
								onClick={() => {
									void session.openPanel(entry).catch((error: unknown) => session.report(error))
								}}
							>
								{unavailable ?? (opened ? '显示' : '打开')}
							</Button>
						</Group>
					)
				})}
			</Stack>
		</Paper>
	)
}
