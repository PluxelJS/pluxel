import { Badge, Button, Group, Stack, Text } from '@mantine/core'
import { IconDashboard, IconExternalLink, IconRocket } from '@tabler/icons-react'
import { definePluginUIModule, ExtensionPoints, type GlobalExtensionContext, type PluginExtensionContext } from '@pluxel/hmr/web'
import { OverviewPanel, EventsPanel, PluginRuntimeProvider, RoutePage, StreamsPanel } from './components'

function HeaderAction() {
	return (
		<Button variant="light" size="xs" leftSection={<IconRocket size={14} />} color="grape">
			PluginWithUI
		</Button>
	)
}

function GlobalStatusBar({ ctx }: { ctx: GlobalExtensionContext }) {
	return (
		<Group gap="xs">
			<Badge variant="dot" color="grape">
				UI Demo
			</Badge>
			<Text size="xs" c="dimmed">
				{ctx.runningPluginsReady ? 'plugins ready' : 'plugins loading…'}
			</Text>
		</Group>
	)
}

function TabOverview({ ctx }: { ctx: PluginExtensionContext }) {
	return (
		<PluginRuntimeProvider ctx={ctx}>
			<OverviewPanel />
		</PluginRuntimeProvider>
	)
}

function TabEvents({ ctx }: { ctx: PluginExtensionContext }) {
	return (
		<PluginRuntimeProvider ctx={ctx}>
			<EventsPanel />
		</PluginRuntimeProvider>
	)
}

function TabStreams({ ctx }: { ctx: PluginExtensionContext }) {
	return (
		<PluginRuntimeProvider ctx={ctx}>
			<StreamsPanel />
		</PluginRuntimeProvider>
	)
}

function PluginInfo({ ctx }: { ctx: PluginExtensionContext }) {
	return (
		<PluginRuntimeProvider ctx={ctx}>
			<Stack gap="xs">
				<Text fw={600}>PluginWithUI</Text>
				<Text size="sm" c="dimmed">
					演示扩展 UI：Tab、Route、SSE、RPC。
				</Text>
				<Button
					variant="light"
					size="xs"
					leftSection={<IconExternalLink size={14} />}
					component="a"
					href={`/plugins/${encodeURIComponent(ctx.pluginName)}/dashboard`}
				>
					打开 Dashboard
				</Button>
			</Stack>
		</PluginRuntimeProvider>
	)
}

function RouteDashboard({ ctx }: { ctx: PluginExtensionContext }) {
	return (
		<PluginRuntimeProvider ctx={ctx}>
			<RoutePage />
		</PluginRuntimeProvider>
	)
}

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.GlobalStatusBar,
			id: 'global-status',
			priority: 50,
			meta: { label: 'PluginWithUI' },
			Component: GlobalStatusBar,
		},
		{
			point: ExtensionPoints.HeaderActions,
			id: 'header-action',
			priority: 100,
			Component: HeaderAction,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'tab-overview',
			priority: 20,
			meta: { label: '概览' },
			when: (ctx) => ctx.pluginName === 'PluginWithUI',
			Component: TabOverview,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'tab-events',
			priority: 19,
			meta: { label: '事件' },
			when: (ctx) => ctx.pluginName === 'PluginWithUI',
			Component: TabEvents,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'tab-streams',
			priority: 18,
			meta: { label: 'Streams' },
			when: (ctx) => ctx.pluginName === 'PluginWithUI',
			Component: TabStreams,
		},
		{
			point: ExtensionPoints.PluginInfo,
			id: 'plugin-info',
			priority: 10,
			requireRunning: true,
			Component: PluginInfo,
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
			Component: RouteDashboard,
		},
	],
	setup({ pluginName }) {
		console.log(`[${pluginName}] UI module loaded`)
	},
})

