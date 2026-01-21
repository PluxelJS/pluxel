// packages/hmr/tests/demo/PluginWithUI/ui/index.tsx
import { Badge, Button, Group, Stack, Text } from '@mantine/core'
import { IconDashboard, IconExternalLink, IconRocket } from '@tabler/icons-react'
import { definePluginUIModule, ExtensionPoints, useExtensionContext } from '@pluxel/hmr/web'
import { OverviewPanel, EventsPanel, RoutePage, StreamsPanel } from './components'

function HeaderAction() {
	return (
		<Button variant="light" size="xs" leftSection={<IconRocket size={14} />} color="grape">
			PluginWithUI
		</Button>
	)
}

function GlobalStatusBar() {
	const ctx = useExtensionContext('global')
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

function PluginInfo() {
	const ctx = useExtensionContext('plugin')
	return (
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
	)
}

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.GlobalStatusBar,
			id: 'global-status',
			priority: 50,
			meta: { label: 'PluginWithUI' },
			render: () => <GlobalStatusBar />,
		},
		{
			point: ExtensionPoints.HeaderActions,
			id: 'header-action',
			priority: 100,
			render: () => <HeaderAction />,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'tab-overview',
			priority: 20,
			meta: { label: '概览' },
			render: () => <OverviewPanel />,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'tab-events',
			priority: 19,
			meta: { label: '事件' },
			render: () => <EventsPanel />,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'tab-streams',
			priority: 18,
			meta: { label: 'Streams' },
			render: () => <StreamsPanel />,
		},
		{
			point: ExtensionPoints.PluginInfo,
			id: 'plugin-info',
			priority: 10,
			requireRunning: true,
			render: () => <PluginInfo />,
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
			render: () => <RoutePage />,
		},
	],
	setup({ pluginName }) {
		console.log(`[${pluginName}] UI module loaded`)
	},
})
