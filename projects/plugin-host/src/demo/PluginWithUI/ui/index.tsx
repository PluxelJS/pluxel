// Browser module registration for the custom UI demo:
// - plugin tabs
// - routes
// - standalone route

import { Button, Group, Stack, Text } from '@mantine/core'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import {
	EventsPanel,
	OverviewPanel,
	RoutePage,
	StandaloneRoutePage,
	StreamsPanel,
} from './components'
import { pluginUi } from './runtime'

function standaloneRouteHref(
	address: ReturnType<typeof useWorkbenchHost>['target']['address'],
	path: string,
) {
	return `/workbench-standalone/${encodeURIComponent(JSON.stringify(address))}${path}`
}

export function PluginInfo() {
	const app = useWorkbenchHost()
	return (
		<Stack gap="xs">
			<Text fw={600}>PluginWithUI</Text>
			<Text size="sm" c="dimmed">
				演示 Workbench UI：Tab、Route、Standalone Route、SSE、RPC。
			</Text>
			<Group gap="xs">
				<Button
					variant="light"
					size="xs"
					disabled={!app.navigation}
					onClick={() => app.navigation?.navigate('/dashboard')}
				>
					打开 Dashboard
				</Button>
				<Button
					variant="subtle"
					size="xs"
					component="a"
					href={standaloneRouteHref(app.target.address, '/standalone')}
				>
					Standalone
				</Button>
			</Group>
		</Stack>
	)
}

export default pluginUi.define({
	PluginInfo,
	OverviewPanel,
	EventsPanel,
	StreamsPanel,
	RoutePage,
	StandaloneRoute: StandaloneRoutePage,
})
