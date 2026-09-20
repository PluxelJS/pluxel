import { lazy, Suspense } from 'react'
import { useWorkbenchDocumentPathname } from '../workbench/context'

const PluginGraphScreen = lazy(() =>
	import('./PluginGraphScreen').then((module) => ({ default: module.PluginGraphScreen })),
)

export function PluginGraphRouteScreen() {
	const pathname = useWorkbenchDocumentPathname()
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
