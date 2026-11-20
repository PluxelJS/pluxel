import { Title } from '@mantine/core'
import { createFileRoute } from '@tanstack/react-router'
import { PinnedApplications } from '../../workbench/PinnedApplications'
import { WorkspaceNavigation } from '../../workbench/WorkspaceNavigation'

function AppsRoute() {
	return (
		<div className="plx-apps">
			<div className="plx-apps__columns">
				<PinnedApplications />
				<section className="plx-apps__catalog" aria-label="全部应用">
					<Title order={2} size="h4">
						全部应用
					</Title>
					<WorkspaceNavigation mode="publications" />
				</section>
			</div>
		</div>
	)
}

export const Route = createFileRoute('/_workbench/apps')({
	staticData: { worksplit: { title: '应用' } },
	component: AppsRoute,
})
