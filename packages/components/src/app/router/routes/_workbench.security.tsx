import { createFileRoute } from '@tanstack/react-router'
import { SecurityScreen } from '../../security/SecurityScreen'

export const Route = createFileRoute('/_workbench/security')({
	component: SecurityScreen,
})
