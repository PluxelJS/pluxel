import { useParams } from '@tanstack/react-router'
import { Plugin } from '../plugins/Plugin'

export function PluginDetailRoute() {
	const { name: rawName } = useParams({ from: '/plugins/$name' })
	let pluginName = rawName
	try {
		pluginName = decodeURIComponent(rawName)
	} catch {
		pluginName = rawName
	}

	return <Plugin pluginName={pluginName} />
}
