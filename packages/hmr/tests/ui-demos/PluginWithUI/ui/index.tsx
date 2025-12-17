// packages/hmr/tests/plugins/ui-demos/PluginWithUI/ui/index.tsx
// 插件 UI 扩展入口模块（拆分组件 + 多 Tab 展示）

import { Stack, Text } from '@mantine/core'
import { IconDashboard } from '@tabler/icons-react'
import { definePluginUIModule, type PluginExtensionContext } from '@pluxel/hmr/web'
import {
	ActivityTimeline,
	Dashboard,
	GlobalStatusBar,
	HeaderButton,
	InfoCard,
	LiveSseActivity,
	NotesPanel,
	RealTimeTicker,
	TaskBoard,
	PluginApiProvider,
	usePluginApi,
} from './components'

function OverviewTabContent({ ctx }: { ctx: PluginExtensionContext }) {
	const { sse } = usePluginApi()
	return (
		<Stack gap="md">
			<InfoCard ctx={ctx} />
			<RealTimeTicker sse={sse} />
		</Stack>
	)
}

function DataTabContent() {
	const { sse } = usePluginApi()
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

function LiveTabContent() {
	const { sse } = usePluginApi()
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

function OverviewTabPanel({ ctx }: { ctx: PluginExtensionContext }) {
	return (
		<PluginApiProvider ctx={ctx}>
			<OverviewTabContent ctx={ctx} />
		</PluginApiProvider>
	)
}

function DataTabPanel({ ctx }: { ctx: PluginExtensionContext }) {
	return (
		<PluginApiProvider ctx={ctx}>
			<DataTabContent />
		</PluginApiProvider>
	)
}

function LiveTabPanel({ ctx }: { ctx: PluginExtensionContext }) {
	return (
		<PluginApiProvider ctx={ctx}>
			<LiveTabContent />
		</PluginApiProvider>
	)
}

function PluginInfoCard({ ctx }: { ctx: PluginExtensionContext }) {
	return (
		<PluginApiProvider ctx={ctx}>
			<InfoCard ctx={ctx} />
		</PluginApiProvider>
	)
}

const module = definePluginUIModule({
	extensions: [
		{
			point: 'global:statusBar',
			id: 'global-statusbar',
			priority: 5,
			meta: { label: 'PluginWithUI' },
			Component: GlobalStatusBar,
		},
		{
			point: 'header:actions',
			id: 'header-actions',
			priority: 100,
			Component: HeaderButton,
		},
		{
			point: 'plugin:tabs',
			id: 'tab-overview',
			priority: 10,
			meta: {
				label: '概览',
			},
			when: (ctx) => ctx.pluginName === 'PluginWithUI',
			Component: OverviewTabPanel,
		},
		{
			point: 'plugin:tabs',
			id: 'tab-data',
			priority: 11,
			meta: {
				label: '数据',
			},
			when: (ctx) => ctx.pluginName === 'PluginWithUI',
			Component: DataTabPanel,
		},
		{
			point: 'plugin:tabs',
			id: 'tab-live',
			priority: 12,
			meta: {
				label: '实时',
			},
			when: (ctx) => ctx.pluginName === 'PluginWithUI',
			Component: LiveTabPanel,
		},
		{
			point: 'plugin:info',
			id: 'plugin-info',
			priority: 5,
			requireRunning: true,
			Component: PluginInfoCard,
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
	setup({ pluginName }) {
		console.log(`[${pluginName}] UI module loaded`)
	},
})

export default module
