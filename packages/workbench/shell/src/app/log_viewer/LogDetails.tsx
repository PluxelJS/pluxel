import { Button, CloseButton, Code, CopyButton, Group, Stack, Text } from '@mantine/core'
import type { RuntimeLogLine } from '../../runtime'
import { formatLineForCopy, messageToText, serializeLogValue, stripAnsi } from './logFormatting'

export interface LogDetailsProps {
	line: RuntimeLogLine
	onClose(): void
	showName?: boolean
	showCategory?: boolean
}
/** The caller chooses drawer, panel or inline placement; details own no docking geometry. */
export function LogDetails({
	line,
	onClose,
	showName = true,
	showCategory = true,
}: LogDetailsProps) {
	return (
		<Stack gap="sm" style={{ minWidth: 0 }}>
			<Group justify="space-between" gap="xs">
				<Text fw={600} size="sm">
					日志详情
				</Text>
				<CloseButton aria-label="关闭日志详情" onClick={onClose} />
			</Group>
			<Text size="xs" c="dimmed">
				{new Date(line.ts).toLocaleString()} · {line.level.toUpperCase()} · #{line.seq}
			</Text>

			{(line.name || line.category?.length || line.context) && (
				<Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
					{[line.name, line.category?.join('.'), line.context].filter(Boolean).join(' · ')}
				</Text>
			)}
			<Group gap="xs">
				<CopyButton value={formatLineForCopy(line, { showName, showCategory })}>
					{({ copied, copy }) => (
						<Button size="compact-xs" variant="default" onClick={copy}>
							{copied ? '已复制文本' : '复制文本'}
						</Button>
					)}
				</CopyButton>
				<CopyButton value={serializeLogValue(line)}>
					{({ copied, copy }) => (
						<Button size="compact-xs" variant="default" onClick={copy}>
							{copied ? '已复制 JSON' : '复制 JSON'}
						</Button>
					)}
				</CopyButton>
			</Group>
			<Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
				{stripAnsi(messageToText(line))}
			</Code>
			{(
				[
					['错误', line.error],
					['属性', line.props],
					['原始记录', line.raw],
				] as const
			).map(([label, value]) =>
				value === undefined || value === null ? null : (
					<Stack key={label} gap="xs">
						<Text fw={600} size="xs">
							{label}
						</Text>
						<Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
							{serializeLogValue(value)}
						</Code>
					</Stack>
				),
			)}
		</Stack>
	)
}
