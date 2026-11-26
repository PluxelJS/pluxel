import { createFileRoute, Outlet, useMatch } from '@tanstack/react-router'
import { DocumentTabs } from '../../workbench/DocumentTabs'

export const Route = createFileRoute('/_workbench/security')({
	staticData: { worksplit: { title: '认证与安全' } },
	component: SecurityRoute,
})

function SecurityRoute() {
	const audit = useMatch({
		from: '/_workbench/security/audit',
		shouldThrow: false,
		select: () => true,
	})
	return (
		<DocumentTabs
			title="认证与安全"
			label="安全中心"
			value={audit ? 'audit' : 'access'}
			sections={[
				{ value: 'access', label: '访问状态', to: '/security' },
				{ value: 'audit', label: '审计记录', to: '/security/audit' },
			]}
		>
			<Outlet />
		</DocumentTabs>
	)
}
