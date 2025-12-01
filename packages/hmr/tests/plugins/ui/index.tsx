// packages/hmr/tests/plugins/ui/index.tsx
// 插件 UI 扩展入口模块

import { Badge, Button, Paper, Text, Group, Stack } from '@mantine/core'
import { IconRocket, IconDashboard } from '@tabler/icons-react'
import {
	definePluginUIModule,
	type ExtensionContext,
} from '../../../src/web'

// ─────────────────────────────────────────────────────────
// Header 按钮组件
// ─────────────────────────────────────────────────────────
function HeaderButton({ ctx }: { ctx: ExtensionContext }) {
	return (
		<Button
			variant="light"
			size="xs"
			leftSection={<IconRocket size={14} />}
			color="grape"
		>
			PluginWithUI
		</Button>
	)
}

// ─────────────────────────────────────────────────────────
// 自定义 Tab 内容
// ─────────────────────────────────────────────────────────
function CustomTab({ ctx }: { ctx: ExtensionContext }) {
	return (
		<Stack gap="md">
			<Text size="lg" fw={600}>
				自定义配置面板
			</Text>
			<Text c="dimmed">
				这是由 PluginWithUI 插件注入的自定义 Tab 内容。
				你可以在这里添加任何自定义的配置界面。
			</Text>
			<Paper withBorder p="md" radius="md">
				<Group justify="space-between">
					<Text>当前插件</Text>
					<Badge color="grape">{ctx.pluginName}</Badge>
				</Group>
			</Paper>
		</Stack>
	)
}

// ─────────────────────────────────────────────────────────
// 插件信息卡片
// ─────────────────────────────────────────────────────────
function InfoCard({ ctx }: { ctx: ExtensionContext }) {
	return (
		<Paper withBorder p="sm" radius="md" bg="grape.0">
			<Stack gap="xs">
				<Group gap="xs">
					<IconRocket size={16} />
					<Text size="sm" fw={500}>
						PluginWithUI 状态
					</Text>
				</Group>
				<Text size="xs" c="dimmed">
					插件正在运行中，提供额外的 UI 扩展功能。
				</Text>
			</Stack>
		</Paper>
	)
}

// ─────────────────────────────────────────────────────────
// Dashboard 页面
// ─────────────────────────────────────────────────────────
function Dashboard() {
	return (
		<Stack gap="lg" p="lg">
			<Group gap="sm">
				<IconDashboard size={24} />
				<Text size="xl" fw={700}>
					PluginWithUI Dashboard
				</Text>
			</Group>

			<Paper withBorder p="lg" radius="md">
				<Stack gap="md">
					<Text>
						这是一个由插件注入的独立页面。
						通过路由扩展，插件可以添加完整的页面到应用中。
					</Text>
					<Text c="dimmed" size="sm">
						路径: /ext/PluginWithUI/dashboard
					</Text>
				</Stack>
			</Paper>
		</Stack>
	)
}

// ─────────────────────────────────────────────────────────
// 模块导出
// ─────────────────────────────────────────────────────────
const module = definePluginUIModule({
	extensions: [
		{
			point: 'header:actions',
			meta: { priority: 100 },
			Component: HeaderButton,
		},
		{
			point: 'plugin:tabs',
			meta: {
				priority: 10,
				label: '自定义面板',
				id: 'PluginWithUI:plugin:tabs',
			},
			when: (ctx) => ctx.pluginName === 'PluginWithUI',
			Component: CustomTab,
		},
		{
			point: 'plugin:info',
			meta: { priority: 5, requireRunning: true },
			when: (ctx) => ctx.pluginName === 'PluginWithUI' && ctx.isPluginRunning === true,
			Component: InfoCard,
		},
	],
	routes: [
		{
			definition: {
				path: '/dashboard',
				title: 'PluginWithUI Dashboard',
				icon: <IconDashboard size={18} stroke={1.7} />,
				addToNav: true,
				navPriority: 50,
			},
			Component: Dashboard,
		},
	],
	setup() {
		console.log('[PluginWithUI] UI module loaded')
	},
})

export const { extensions, routes, setup } = module
export default module
