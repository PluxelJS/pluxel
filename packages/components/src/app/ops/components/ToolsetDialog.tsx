import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core'
import type { ToolsetDialogState } from '../types'

export function ToolsetDialog({
	description,
	name,
	onClose,
	onDescriptionChange,
	onNameChange,
	onSubmit,
	saving,
	state,
}: {
	description: string
	name: string
	onClose: () => void
	onDescriptionChange: (value: string) => void
	onNameChange: (value: string) => void
	onSubmit: () => void
	saving: boolean
	state: ToolsetDialogState
}) {
	if (state.mode === 'closed') return null

	return (
		<Modal
			opened
			onClose={onClose}
			title={state.mode === 'create' ? '新建 Toolset' : '重命名 Toolset'}
			centered
		>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					Toolset 只保存一组 op id 和用途描述，方便宿主 UI 与 LLM/Agent 复用。
				</Text>
				<TextInput
					label="Toolset 名称"
					placeholder="例如：发布检查、常用维护、内容流水线"
					value={name}
					onChange={(event) => onNameChange(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key !== 'Enter') return
						event.preventDefault()
						onSubmit()
					}}
				/>
				<TextInput
					label="用途描述"
					placeholder="例如：用于发布前检查插件状态、依赖和配置，不包含内容生成类工具"
					value={description}
					onChange={(event) => onDescriptionChange(event.currentTarget.value)}
				/>
				<Group justify="flex-end">
					<Button variant="default" onClick={onClose}>
						取消
					</Button>
					<Button loading={saving} onClick={onSubmit}>
						保存
					</Button>
				</Group>
			</Stack>
		</Modal>
	)
}
