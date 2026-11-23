import { createFileRoute } from '@tanstack/react-router'
import { SecurityAuditScreen } from '../../security/SecurityAuditScreen'

export const Route = createFileRoute('/_workbench/security/audit')({
	component: SecurityAuditScreen,
})
