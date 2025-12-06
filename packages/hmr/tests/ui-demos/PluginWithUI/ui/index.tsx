// packages/hmr/tests/plugins/ui-demos/PluginWithUI/ui/index.tsx
// 插件 UI 扩展入口模块（拆分组件 + 多 Tab 展示）

import { Stack, Text } from '@mantine/core'
import { IconDashboard } from '@tabler/icons-react'
import { definePluginUIModule, type ExtensionContext } from '@pluxel/hmr/web'
import {
	ActivityTimeline,
	Dashboard,
	HeaderButton,
	InfoCard,
	LiveSseActivity,
	NotesPanel,
	RealTimeTicker,
	TaskBoard,
	usePluginSse,
} from './components'

function OverviewTabPanel({ ctx }: { ctx: ExtensionContext }) {
	const sse = usePluginSse(ctx.pluginName)
	return (
		<Stack gap="md">
			<InfoCard ctx={ctx} />
			<RealTimeTicker sse={sse} />
		</Stack>
	)
}

function DataTabPanel({ ctx }: { ctx: ExtensionContext }) {
	const sse = usePluginSse(ctx.pluginName)
	return (
		<Stack gap="md">
			<Text size="sm" c="dimmed">
				使用 RPC + cursor SSE 同步，演示多 Collection（notes/tasks）的互动。
			</Text>
			<NotesPanel sse={sse} />
			<TaskBoard sse={sse} />
		</Stack>
	)
}

function LiveTabPanel({ ctx }: { ctx: ExtensionContext }) {
	const sse = usePluginSse(ctx.pluginName)
	return (
		<Stack gap="md">
			<Text size="sm" c="dimmed">
				实时事件总览：日志、插件 SSE（tick/sync/cursor）与活动流。
			</Text>
			<LiveSseActivity sse={sse} />
			<ActivityTimeline sse={sse} />
		</Stack>
	)
}

const module = definePluginUIModule({
	extensions: [
		{
			point: 'header:actions',
			meta: { priority: 100, id: 'PluginWithUI:header:actions' },
			Component: HeaderButton,
		},
		{
			point: 'plugin:tabs',
			meta: {
				priority: 10,
				label: '概览',
				id: 'PluginWithUI:plugin:tabs:overview',
			},
			when: (ctx) => ctx.pluginName === 'PluginWithUI',
			Component: OverviewTabPanel,
		},
		{
			point: 'plugin:tabs',
			meta: {
				priority: 11,
				label: '数据',
				id: 'PluginWithUI:plugin:tabs:data',
			},
			when: (ctx) => ctx.pluginName === 'PluginWithUI',
			Component: DataTabPanel,
		},
		{
			point: 'plugin:tabs',
			meta: {
				priority: 12,
				label: '实时',
				id: 'PluginWithUI:plugin:tabs:live',
			},
			when: (ctx) => ctx.pluginName === 'PluginWithUI',
			Component: LiveTabPanel,
		},
		{
			point: 'plugin:info',
			meta: { priority: 5, requireRunning: true, id: 'PluginWithUI:plugin:info' },
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

export default module
