import { Outlet, useParams } from '@tanstack/react-router'
import { Plugin } from '../plugins/Plugin'

export function PluginDetailRoute() {
	const { name: rawName } = useParams({ from: '/plugins/$name' })
	let pluginName = rawName
	try {
		pluginName = decodeURIComponent(rawName)
	} catch {
		pluginName = rawName
	}

	return (
		<>
			<Plugin pluginName={pluginName} />
			{/* 让 /plugins/$name/$path* 作为“子路由”存在但不卸载插件页（避免切换子路由时整页重置） */}
			<div style={{ display: 'none' }}>
				<Outlet />
			</div>
		</>
	)
}
