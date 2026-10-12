import { lazy, Suspense } from 'react'
import { useCurrentPathname } from '../router/useCurrentRoute'

const PluginGraphScreen = lazy(() =>
	import('./PluginGraphScreen').then((module) => ({ default: module.PluginGraphScreen })),
)

export function PluginGraphRouteScreen() {
	const pathname = useCurrentPathname()
	return <LazyPluginGraphScreen pathname={pathname} />
}

export function LazyPluginGraphScreen({ pathname }: { pathname: string }) {
	return (
		<Suspense
			fallback={
				<div className="plx-pluginGraphState" role="status">
					正在加载依赖图界面…
				</div>
			}
		>
			<PluginGraphScreen pathname={pathname} />
		</Suspense>
	)
}
