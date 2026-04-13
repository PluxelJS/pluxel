// Browser module registration for the custom UI demo:
// - extensions
// - routes
// - standalone route

import { Button, Group, Stack, Text } from '@mantine/core'
import { definePluginUIModule, ExtensionPoints } from '@pluxel/runtime/web/ui'
import { IconDashboard, IconExternalLink, IconRocket } from '@tabler/icons-react'
import {
	EventsPanel,
	OverviewPanel,
	RoutePage,
	StandaloneRoutePage,
	StreamsPanel,
} from './components'
import { plugin } from './runtime'

function pluginRouteHref(pluginName: string, path: string) {
	return `/plugins/${encodeURIComponent(pluginName)}${path}`
}

function standaloneRouteHref(pluginName: string, path: string) {
	return `/ext-standalone/${encodeURIComponent(pluginName)}${path}`
}

function HeaderAction() {
	return (
		<Button variant="light" size="xs" leftSection={<IconRocket size={14} />} color="grape">
			PluginWithUI
		</Button>
	)
}

function PluginInfo() {
	const app = plugin.use()
	return (
		<Stack gap="xs">
			<Text fw={600}>PluginWithUI</Text>
			<Text size="sm" c="dimmed">
				演示扩展 UI：Tab、Route、Standalone Route、SSE、RPC。
			</Text>
			<Group gap="xs">
				<Button
					variant="light"
					size="xs"
					leftSection={<IconExternalLink size={14} />}
					component="a"
					href={pluginRouteHref(app.pluginName, '/dashboard')}
				>
					打开 Dashboard
				</Button>
				<Button
					variant="subtle"
					size="xs"
					component="a"
					href={standaloneRouteHref(app.pluginName, '/standalone')}
				>
					Standalone
				</Button>
			</Group>
		</Stack>
	)
}

export default definePluginUIModule({
	extensions: [
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
		{
			definition: {
				path: '/notes',
				title: 'PluginWithUI Notes',
			},
			render: () => <RoutePage />,
		},
		{
			definition: {
				path: '/standalone',
				title: 'PluginWithUI Standalone',
				addToNav: true,
				navPriority: 40,
				frame: 'standalone',
			},
			render: () => <StandaloneRoutePage />,
		},
	],
})
