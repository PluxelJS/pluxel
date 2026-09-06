import { ActionIcon, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core'
import { IconTrash } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { GroupConfig } from '../types'

export function GroupEditorModal({
	opened,
	groups,
	onClose,
	onSubmit,
	onReset,
}: {
	opened: boolean
	groups: GroupConfig[]
	onClose: () => void
	onReset?: () => void
	onSubmit: (groups: GroupConfig[]) => void
}) {
	const [draft, setDraft] = useState<GroupConfig[]>([])
	useEffect(() => {
		if (opened) setDraft(groups.map((group) => ({ ...group, pluginIds: [...group.pluginIds] })))
	}, [opened, groups])
	return (
		<Modal opened={opened} onClose={onClose} title="编辑插件分组" centered>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					保存后固定当前分组。删除分组会将成员移回未分组；新插件继续按依赖自动归类。
				</Text>
				{draft.map((group) => (
					<Group key={group.groupId} wrap="nowrap">
						<TextInput
							style={{ flex: 1 }}
							aria-label="分组名称"
							value={group.name}
							onChange={(event) => {
								const name = event.currentTarget.value
								setDraft((previous) =>
									previous.map((item) =>
										item.groupId === group.groupId ? { ...item, name } : item,
									),
								)
							}}
						/>
						<ActionIcon
							variant="subtle"
							color="red"
							aria-label={`删除分组 ${group.name}`}
							onClick={() =>
								setDraft((previous) => previous.filter((item) => item.groupId !== group.groupId))
							}
						>
							<IconTrash size={16} />
						</ActionIcon>
					</Group>
				))}
				<Button
					variant="light"
					onClick={() =>
						setDraft((previous) => [
							...previous,
							{ groupId: `manual:${crypto.randomUUID()}`, name: '新分组', pluginIds: [] },
						])
					}
				>
					新增分组
				</Button>
				{onReset ? (
					<Button variant="subtle" onClick={onReset}>
						恢复自动分组
					</Button>
				) : null}
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						取消
					</Button>
					<Button
						disabled={draft.some((group) => !group.name.trim())}
						onClick={() =>
							onSubmit(draft.map((group) => Object.assign({}, group, { name: group.name.trim() })))
						}
					>
						保存
					</Button>
				</Group>
			</Stack>
		</Modal>
	)
}
