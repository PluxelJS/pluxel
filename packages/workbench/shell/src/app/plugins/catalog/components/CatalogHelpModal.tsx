import { Badge, Group, Modal, Stack, Text } from '@mantine/core'
import {
	CATALOG_SHORTCUT_ITEMS,
	PLUGIN_DETAIL_SHORTCUT_ITEMS,
	WORKBENCH_SHORTCUT_ITEMS,
} from '../../../workbench/shortcuts'

type CatalogHelpModalProps = {
	opened: boolean
	onClose: () => void
}

const searchTokens = [
	['普通关键词', '匹配名称、定义位置、导出名等；多词为 AND'],
	['@包名', '匹配包名'],
	['ref:关键词', '匹配插件引用'],
	['exec:关键词', '匹配执行方式与最近结果，如 hmr、失败'],
]

export function CatalogHelpModal({ opened, onClose }: CatalogHelpModalProps) {
	return (
		<Modal opened={opened} onClose={onClose} title="插件列表快捷操作" centered size="lg">
			<Stack gap="md">
				<Stack gap="xs">
					<Text fw={700} size="sm">
						工作台快捷键
					</Text>
					{WORKBENCH_SHORTCUT_ITEMS.map(([key, description]) => (
						<Group key={key} justify="space-between" align="center" wrap="nowrap">
							<Badge variant="light" color="grape" size="sm">
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
						插件列表快捷键
					</Text>
					{CATALOG_SHORTCUT_ITEMS.map(([key, description]) => (
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
						插件详情快捷键
					</Text>
					{PLUGIN_DETAIL_SHORTCUT_ITEMS.map(([key, description]) => (
						<Group key={key} justify="space-between" align="center" wrap="nowrap">
							<Badge variant="light" color="teal" size="sm">
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
