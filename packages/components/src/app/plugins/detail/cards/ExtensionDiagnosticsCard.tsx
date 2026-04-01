import { Badge, Group, Paper, Stack, Text } from '@mantine/core'
import {
	extensionInteractionReasonLabel,
	type PluginExtensionDiagnosticsSummary,
	usePluginUiStatus,
} from '../../../../extension'
import { usePluginMeta } from '../context'

function summarizeIssue(
	item: PluginExtensionDiagnosticsSummary['issues'][number],
	pluginName: string,
): string {
	const isIncoming = item.targetPlugin === pluginName
	if (isIncoming) {
		return `${item.surface ?? item.contract.id} <- ${item.providerPlugin ?? item.offerId}`
	}
	if (!item.targetPlugin) {
		return `${item.offerId} -> waiting target`
	}
	return `${item.surface ?? item.contract.id} -> ${item.targetPlugin}`
}

export function ExtensionDiagnosticsCard() {
	const { pluginName } = usePluginMeta()
	const { diagnostics, summary, hasDiagnostics } = usePluginUiStatus(pluginName)
	if (!hasDiagnostics) return null

	return (
		<Paper withBorder radius="md" p="sm" shadow="xs">
			<Stack gap="xs">
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Stack gap={2} style={{ minWidth: 0 }}>
						<Text size="sm" fw={600}>
							跨插件扩展
						</Text>
						<Text size="xs" c="dimmed">
							当前插件声明了 {diagnostics.surfaces.length} 个 surface、{diagnostics.offers.length}{' '}
							个 offer；收到 {summary.incomingActive.length} 个 active interaction，发出{' '}
							{summary.outgoingActive.length} 个 active interaction。
						</Text>
					</Stack>
					<Badge size="xs" variant="light" color={summary.tone}>
						{summary.issues.length > 0 ? `${summary.issues.length} 个待处理项` : '已连接'}
					</Badge>
				</Group>

				<Group gap="xs">
					<Badge size="xs" variant="light" color="gray">
						surfaces {diagnostics.surfaces.length}
					</Badge>
					<Badge size="xs" variant="light" color="gray">
						offers {diagnostics.offers.length}
					</Badge>
					<Badge size="xs" variant="light" color="gray">
						sessions {diagnostics.sessions.length}
					</Badge>
					<Badge
						size="xs"
						variant="light"
						color={summary.incomingIssues.length > 0 ? 'yellow' : 'blue'}
					>
						incoming {diagnostics.incoming.length}
					</Badge>
					<Badge
						size="xs"
						variant="light"
						color={summary.outgoingIssues.length > 0 ? 'yellow' : 'blue'}
					>
						outgoing {diagnostics.outgoing.length}
					</Badge>
				</Group>

				{summary.issues.length > 0 ? (
					<Stack gap={4}>
						{summary.issues.slice(0, 4).map((item) => (
							<Text
								key={`${item.targetPlugin ?? 'waiting'}:${item.surface ?? 'none'}:${item.offerId}:${item.state}`}
								size="xs"
							>
								{summarizeIssue(item, pluginName)}: {extensionInteractionReasonLabel(item.reason)}
							</Text>
						))}
					</Stack>
				) : (
					<Text size="xs" c="dimmed">
						当前没有 rejected / waiting interaction；surface 与 offer 的匹配状态正常。
					</Text>
				)}
			</Stack>
		</Paper>
	)
}
