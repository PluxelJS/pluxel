import { Badge, Group, Modal, Stack, Text } from '@mantine/core'

type CatalogHelpModalProps = {
	opened: boolean
	onClose: () => void
}

const shortcuts = [
	['/', '聚焦搜索'],
	['Esc', '清空搜索或清空选择'],
	['↑ / ↓', '切换当前焦点项'],
	['Shift + ↑ / ↓', '连续选择'],
	['Space', '切换当前项选择状态'],
	['Ctrl/⌘ + A', '全选当前可见插件'],
	['Enter', '打开当前焦点插件'],
	['G', '创建分组，若已有选择则收拢为新分组'],
	['M', '将当前选择移动到分组'],
	['U', '将当前选择移回未分组'],
]

const searchTokens = [
	['普通关键词', '匹配插件名、ID、包名、tag、版本'],
	['@包名', '仅匹配 packageName'],
	['#tag', '仅匹配 tag'],
	['v:版本', '仅匹配 version'],
	['id:关键词', '仅匹配插件 ID'],
]

export function CatalogHelpModal({ opened, onClose }: CatalogHelpModalProps) {
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title="插件列表快捷操作"
			centered
			size="lg"
			radius="md"
		>
			<Stack gap="lg">
				<Stack gap="xs">
					<Text fw={700} size="sm">
						快捷键
					</Text>
					{shortcuts.map(([key, description]) => (
						<Group key={key} justify="space-between" align="center" wrap="nowrap">
							<Badge variant="light" color="gray" size="sm">
								{key}
							</Badge>
							<Text size="sm" c="dimmed" style={{ flex: 1 }}>
								{description}
							</Text>
						</Group>
					))}
				</Stack>

				<Stack gap="xs">
					<Text fw={700} size="sm">
						搜索语法
					</Text>
					{searchTokens.map(([token, description]) => (
						<Group key={token} justify="space-between" align="center" wrap="nowrap">
							<Badge variant="light" color="blue" size="sm">
								{token}
							</Badge>
							<Text size="sm" c="dimmed" style={{ flex: 1 }}>
								{description}
							</Text>
						</Group>
					))}
				</Stack>
			</Stack>
		</Modal>
	)
}
