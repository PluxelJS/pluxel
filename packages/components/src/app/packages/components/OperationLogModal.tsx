import { Badge, Box, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core'
import { LiveLog } from '../../log_viewer/LiveLog'

export type OperationLogEntry = {
	label: string
	status: 'pending' | 'running' | 'success' | 'error'
	message?: string
}

interface OperationLogModalProps {
	opened: boolean
	onClose: () => void
	title: string
	logs: OperationLogEntry[]
	logModule?: string
}

export function OperationLogModal({
	opened,
	onClose,
	title,
	logs,
	logModule = 'package-manager',
}: OperationLogModalProps) {
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={title}
			centered
			size="xl"
			styles={{ body: { display: 'flex', flexDirection: 'column', gap: 12 } }}
		>
			{logs.length > 0 && (
				<ScrollArea.Autosize mah={180}>
					<Stack gap="xs">
						{logs.map((log, index) => {
							const color =
								log.status === 'success'
									? 'green'
									: log.status === 'error'
										? 'red'
										: log.status === 'running'
											? 'blue'
											: 'gray'
							const statusLabel =
								log.status === 'pending'
									? '等待中'
									: log.status === 'running'
										? '进行中'
										: log.status === 'success'
											? '完成'
											: '失败'
							return (
								<Group key={`${log.label}-${index}`} gap="sm" align="flex-start">
									<Badge color={color} variant="light" size="sm">
										{statusLabel}
									</Badge>
									<Stack gap={2} style={{ flex: 1 }}>
										<Text fw={500} size="sm">
											{log.label}
										</Text>
										{log.message && (
											<Text size="xs" c={log.status === 'error' ? 'red' : 'dimmed'}>
												{log.message}
											</Text>
										)}
									</Stack>
								</Group>
							)
						})}
					</Stack>
				</ScrollArea.Autosize>
			)}
			<Box
				style={{
					border: '1px solid var(--mantine-color-gray-3)',
					borderRadius: 12,
					padding: 'var(--mantine-spacing-xs)',
					height: '48vh',
					minHeight: 280,
					overflow: 'hidden',
					background: 'var(--mantine-color-body)',
					display: 'flex',
				}}
			>
				<LiveLog module={logModule} variant="embedded" />
			</Box>
		</Modal>
	)
}
