import { createFileRoute } from '@tanstack/react-router'
import { EXTENSION_STANDALONE_ROUTE_PREFIX } from '../../../extension'
import { ExtensionRouteScreen } from '../extensions'

export const Route = createFileRoute('/_standalone/ext-standalone/$pluginName/$')({
	component: () => <ExtensionRouteScreen prefix={EXTENSION_STANDALONE_ROUTE_PREFIX} />,
})
