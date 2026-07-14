// Browser module registration for the custom UI demo:
// - extensions
// - routes
// - standalone route

import { Button, Group, Stack, Text } from '@mantine/core'
import { IconExternalLink, IconRocket } from '@tabler/icons-react'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import {
	EventsPanel,
	OverviewPanel,
	RoutePage,
	StandaloneRoutePage,
	StreamsPanel,
} from './components'
import { pluginUi } from './runtime'

function pluginRouteHref(pluginName: string, path: string) {
	return `/plugins/${encodeURIComponent(pluginName)}${path}`
}

function standaloneRouteHref(pluginName: string, path: string) {
	return `/ext-standalone/${encodeURIComponent(pluginName)}${path}`
}

export function HeaderAction() {
	return (
		<Button variant="light" size="xs" leftSection={<IconRocket size={14} />} color="grape">
			PluginWithUI
		</Button>
	)
}

export function PluginInfo() {
	const app = useWorkbenchHost()
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
					href={pluginRouteHref(app.targetPluginId, '/dashboard')}
				>
					打开 Dashboard
				</Button>
				<Button
					variant="subtle"
					size="xs"
					component="a"
					href={standaloneRouteHref(app.targetPluginId, '/standalone')}
				>
					Standalone
				</Button>
			</Group>
		</Stack>
	)
}

export default pluginUi.define({
	HeaderAction,
	PluginInfo,
	OverviewPanel,
	EventsPanel,
	StreamsPanel,
	RoutePage,
	StandaloneRoute: StandaloneRoutePage,
})
