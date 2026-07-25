import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core'
import { useEffect, useState } from 'react'

type GroupEditorModalProps = {
	opened: boolean
	title: string
	description: string
	confirmLabel: string
	initialValue?: string
	onClose: () => void
	onSubmit: (name: string) => void
}

export function GroupEditorModal({
	opened,
	title,
	description,
	confirmLabel,
	initialValue = '',
	onClose,
	onSubmit,
}: GroupEditorModalProps) {
	const [value, setValue] = useState(initialValue)

	useEffect(() => {
		if (!opened) return
		setValue(initialValue)
	}, [initialValue, opened])

	return (
		<Modal opened={opened} onClose={onClose} title={title} centered size="sm" radius="sm">
			<form
				onSubmit={(event) => {
					event.preventDefault()
					const nextName = value.trim()
					if (!nextName) return
					onSubmit(nextName)
				}}
			>
				<Stack gap="sm">
					<Text size="sm" c="dimmed">
						{description}
					</Text>
					<TextInput
						autoFocus
						label="分组名称"
						placeholder="例如：核心插件"
						value={value}
						onChange={(event) => setValue(event.currentTarget.value)}
						maxLength={48}
					/>
					<Group justify="flex-end" gap="xs">
						<Button variant="default" onClick={onClose}>
							取消
						</Button>
						<Button type="submit" disabled={value.trim().length === 0}>
							{confirmLabel}
						</Button>
					</Group>
				</Stack>
			</form>
		</Modal>
	)
}
