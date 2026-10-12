import { createFileRoute } from '@tanstack/react-router'
import { SecurityAuditScreen } from '../../security/SecurityAuditScreen'

export const Route = createFileRoute('/_workbench/security_/audit')({
	staticData: { worksplit: { title: '安全审计' } },
	component: SecurityAuditScreen,
})
