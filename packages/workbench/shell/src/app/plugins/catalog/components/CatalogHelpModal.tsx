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
	['普通关键词', '匹配插件名、定义位置、导出名、身份与执行方式；多个词为 AND'],
	['@包名', '仅匹配定义地址中的 packageName'],
	['ref:关键词', '仅匹配 canonical plugin reference'],
	['exec:关键词', '仅匹配执行、更新方式与最近结果，例如 hmr、bundle、失败'],
]

export function CatalogHelpModal({ opened, onClose }: CatalogHelpModalProps) {
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title="插件列表快捷操作"
			centered
			size="lg"
			radius="sm"
		>
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
