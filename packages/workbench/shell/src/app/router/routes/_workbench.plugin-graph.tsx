import { createFileRoute } from '@tanstack/react-router'
import { PluginGraphRouteScreen } from '../../plugin-graph/LazyPluginGraphScreen'

export const Route = createFileRoute('/_workbench/plugin-graph')({
	component: PluginGraphRouteScreen,
})
