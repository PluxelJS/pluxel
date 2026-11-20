import { Button, Group, Modal, Select, Stack, Text } from '@mantine/core'
import { useEffect, useState } from 'react'

type GroupPlacementOption = {
	value: string
	label: string
}

type GroupPlacementModalProps = {
	opened: boolean
	count: number
	options: GroupPlacementOption[]
	initialValue?: string
	onClose: () => void
	onSubmit: (targetGroupId: string) => void
}

export function GroupPlacementModal({
	opened,
	count,
	options,
	initialValue,
	onClose,
	onSubmit,
}: GroupPlacementModalProps) {
	const [value, setValue] = useState<string | null>(initialValue ?? options[0]?.value ?? null)

	useEffect(() => {
		if (!opened) return
		setValue(initialValue ?? options[0]?.value ?? null)
	}, [initialValue, opened, options])

	return (
		<Modal opened={opened} onClose={onClose} title="移动到分组" centered size="sm">
			<form
				onSubmit={(event) => {
					event.preventDefault()
					if (!value) return
					onSubmit(value)
				}}
			>
				<Stack gap="sm">
					<Text size="sm" c="dimmed">
						已选 {count} 个插件
					</Text>
					<Select
						autoFocus
						label="目标分组"
						data={options}
						value={value}
						onChange={setValue}
						allowDeselect={false}
					/>
					<Group justify="flex-end" gap="xs">
						<Button variant="default" onClick={onClose}>
							取消
						</Button>
						<Button type="submit" disabled={!value}>
							移动
						</Button>
					</Group>
				</Stack>
			</form>
		</Modal>
	)
}
