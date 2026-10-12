import { formatPluginNodeRoute } from '@pluxel/core'
import { createFileRoute } from '@tanstack/react-router'
import { PluginScreen } from '../../plugins/detail/PluginScreen'
import { validatePluginDetailSearch } from '../pluginDetailSearch'
import { parsePluginDetailHref } from '../../../workbench/paths'
import { useCurrentPathname } from '../useCurrentRoute'

function PluginDetailRoute() {
	const parsed = parsePluginDetailHref(useCurrentPathname())
	const pluginRoute = parsed ? formatPluginNodeRoute(parsed.target) : ''
	return <PluginScreen key={pluginRoute} pluginRoute={pluginRoute} />
}

export const Route = createFileRoute('/_workbench/plugins/$')({
	validateSearch: validatePluginDetailSearch,
	staticData: { worksplit: { title: '插件详情', identitySearch: ['entry'] } },
	component: PluginDetailRoute,
})
