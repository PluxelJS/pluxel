import { formatPluginNodeRoute } from '@pluxel/core'
import { AgentToolsScreen } from '../../agent-tools/AgentToolsScreen'
import { LiveLog } from '../../log_viewer/LiveLog'
import { PluginCatalog } from '../../plugins/catalog/PluginCatalog'
import { PluginScreen } from '../../plugins/detail/PluginScreen'
import { LazyPluginGraphScreen } from '../../plugin-graph/LazyPluginGraphScreen'
import { NotFoundScreen } from '../../router/screens/NotFoundScreen'
import { HomeScreen } from '../../router/screens/HomeScreen'
import { WorkbenchRouteScreen } from '../../router/workbench/WorkbenchRouteScreen'
import { SecurityAuditScreen } from '../../security/SecurityAuditScreen'
import { SecurityScreen } from '../../security/SecurityScreen'
import {
	WORKBENCH_ROUTE_PREFIX,
	parsePluginDetailHref,
	parseWorkbenchHref,
} from '../../../workbench/paths'

/** Host-owned document router: renders any Tab path independently of the browser location. */
export function WorkbenchDocumentRenderer({ pathname }: { pathname: string }) {
	if (pathname === '/') return <HomeScreen />
	if (pathname === '/logs') return <LiveLog />
	if (pathname === '/security') return <SecurityScreen />
	if (pathname === '/security/audit') return <SecurityAuditScreen />
	if (pathname === '/agent-tools') return <AgentToolsScreen />
	if (pathname === '/plugin-graph' || pathname.startsWith('/plugin-graph/')) {
		return <LazyPluginGraphScreen pathname={pathname} />
	}
	if (pathname === '/plugins' || pathname === '/plugins/') {
		return (
			<div className="plx-pluginCatalogPage">
				<PluginCatalog />
			</div>
		)
	}

	const pluginDetail = parsePluginDetailHref(pathname)
	if (pluginDetail) return <PluginScreen pluginRoute={formatPluginNodeRoute(pluginDetail.target)} />

	const workbenchRoute = parseWorkbenchHref(pathname)
	if (workbenchRoute?.frame === 'shell') {
		return <WorkbenchRouteScreen prefix={WORKBENCH_ROUTE_PREFIX} pathname={pathname} />
	}

	return <NotFoundScreen pathname={pathname} />
}
