import { Affix, Badge, Button, Group, Paper, Stack, Text, Tooltip } from '@mantine/core'
import { SavedStatus } from './SavedStatus'

type ActiveState = {
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
}

export function ConfigActionDock({
	activeKey,
	activeState,
	activeSavedAt,
	dirtyKeys,
	hasMultipleSchemas,
	savingAll,
	onSubmitCurrent,
	onSubmitAll,
	onResetCurrent,
	onResetDefaults,
}: {
	activeKey: string
	activeState: ActiveState
	activeSavedAt?: number
	dirtyKeys: string[]
	hasMultipleSchemas: boolean
	savingAll: boolean
	onSubmitCurrent: () => void
	onSubmitAll: () => void
	onResetCurrent: () => void
	onResetDefaults: () => void
}) {
	const dirtyCount = dirtyKeys.length
	const dirtyLabel =
		dirtyCount > 0
			? `${dirtyKeys.slice(0, 3).join(', ')}${dirtyCount > 3 ? ` +${dirtyCount - 3}` : ''}`
			: '没有未保存的配置'

	return (
		<Affix position={{ bottom: 16, right: 16 }} withinPortal zIndex={1000}>
			<Paper withBorder radius="xl" p="xs" shadow="md">
				<Stack gap={6}>
					<Group justify="space-between" wrap="nowrap">
						<Group gap="xs" wrap="nowrap">
							<Text fw={600} size="sm">
								{activeKey}
							</Text>
							<SavedStatus dirty={activeState.dirty} savedAt={activeSavedAt} />
						</Group>
						{dirtyCount > 0 ? (
							<Tooltip label={dirtyLabel} withArrow>
								<Badge variant="light" color="yellow">
									已修改 {dirtyCount}
								</Badge>
							</Tooltip>
						) : (
							<Badge variant="light" color="green">
								全部已保存
							</Badge>
						)}
					</Group>

					<Group gap="xs" wrap="nowrap">
						<Button
							size="xs"
							variant="default"
							onClick={onResetCurrent}
							disabled={!activeState.dirty || activeState.submitting}
						>
							撤销当前
						</Button>
						<Button
							size="xs"
							variant="subtle"
							onClick={onResetDefaults}
							disabled={activeState.submitting}
						>
							重置默认
						</Button>
						<Button
							size="xs"
							onClick={onSubmitCurrent}
							loading={activeState.submitting}
							disabled={!activeState.dirty || !activeState.canSubmit}
						>
							提交当前
						</Button>
						{hasMultipleSchemas ? (
							<Button
								size="xs"
								variant="light"
								onClick={onSubmitAll}
								loading={savingAll}
								disabled={dirtyCount === 0 || savingAll}
							>
								提交全部
							</Button>
						) : null}
					</Group>
				</Stack>
			</Paper>
		</Affix>
	)
}
