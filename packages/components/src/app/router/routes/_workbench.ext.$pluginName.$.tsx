import { createFileRoute } from '@tanstack/react-router'
import { EXTENSION_ROUTE_PREFIX } from '../../../extension'
import { ExtensionRouteScreen } from '../extensions/ExtensionRouteScreen'

export const Route = createFileRoute('/_workbench/ext/$pluginName/$')({
	component: () => <ExtensionRouteScreen prefix={EXTENSION_ROUTE_PREFIX} />,
})
