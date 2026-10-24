import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/_standalone')({
	component: Outlet,
})
