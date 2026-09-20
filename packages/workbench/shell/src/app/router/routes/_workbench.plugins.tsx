import { Outlet, createFileRoute } from '@tanstack/react-router'

function PluginsOutletRoute() {
	return <Outlet />
}

export const Route = createFileRoute('/_workbench/plugins')({
	component: PluginsOutletRoute,
})
