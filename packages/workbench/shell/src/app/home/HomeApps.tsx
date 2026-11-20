import { IconArrowUpRight } from '@tabler/icons-react'
import { useMemo } from 'react'
import { buildPluginDetailHref } from '../../workbench/paths'
import { getWorkbenchDirectoryHref } from '../../workbench/route-directory'
import { useWorkbenchTargetSnapshot } from '../../workbench/runtime'
import { useWorkbenchNavigation } from '../workbench/context'

/** Published page entries as one-click shortcuts; parameterised routes go through the apps page. */
export function HomeApps() {
	const navigation = useWorkbenchNavigation()
	const snapshot = useWorkbenchTargetSnapshot(null)
	const apps = useMemo(() => {
		const routes = snapshot.directory.routes
		return (snapshot.layout?.entries ?? []).flatMap((entry) => {
			const placement = entry.placement
			if (placement.kind === 'tab')
				return [
					{
						key: `${buildPluginDetailHref(entry.target.node)}:${entry.descriptor.key}`,
						label: placement.label ?? entry.descriptor.key,
						owner: entry.target.displayName,
						standalone: false,
						href: `${buildPluginDetailHref(entry.target.node)}?entry=${encodeURIComponent(entry.descriptor.key)}`,
					},
				]
			if (placement.kind !== 'route') return []
			const route = routes.find((candidate) => candidate.entry === entry)
			const parameterised = route?.compiled.segments.some((segment) => segment.parameter)
			return [
				{
					key: `${buildPluginDetailHref(entry.target.node)}:${entry.descriptor.key}`,
					label: placement.navigation?.label ?? placement.title,
					owner: entry.target.displayName,
					standalone: placement.frame === 'standalone',
					href: parameterised
						? '/apps'
						: getWorkbenchDirectoryHref(snapshot.directory, entry.target.node, placement.path),
				},
			]
		})
	}, [snapshot.directory, snapshot.layout])
	if (apps.length === 0) return null
	return (
		<section aria-labelledby="plx-home-apps-title" className="plx-home__apps">
			<div className="plx-home__sectionHeader">
				<h2 id="plx-home-apps-title" className="plx-home__sectionTitle">
					应用
				</h2>
			</div>
			<div className="plx-home__appGrid">
				{apps.map((app) => (
					<button
						type="button"
						key={app.key}
						className="plx-home__app"
						title={`${app.label} · ${app.owner}`}
						onClick={() => navigation.navigate(app.href)}
					>
						<span className="plx-home__appLabel">{app.label}</span>
						<span className="plx-home__appOwner">{app.owner}</span>
						{app.standalone ? <IconArrowUpRight size={13} aria-label="独立页面" /> : null}
					</button>
				))}
			</div>
		</section>
	)
}
