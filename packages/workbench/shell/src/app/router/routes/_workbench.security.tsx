import { createFileRoute } from '@tanstack/react-router'
import { SecurityScreen } from '../../security/SecurityScreen'

export const Route = createFileRoute('/_workbench/security')({
	staticData: { worksplit: { title: '认证与安全' } },
	component: SecurityScreen,
})
