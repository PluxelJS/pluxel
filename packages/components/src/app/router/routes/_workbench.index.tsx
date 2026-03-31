import { createFileRoute } from '@tanstack/react-router'
import { HomeRoute } from '../views'

export const Route = createFileRoute('/_workbench/')({
	component: HomeRoute,
})
