import { IconArrowUpRight } from '@tabler/icons-react'
import { useMemo } from 'react'
import { buildPluginDetailHref } from '../../workbench/paths'
import { getWorkbenchDirectoryHref } from '../../workbench/route-directory'
import { useWorkbenchTargetSnapshot } from '../../workbench/runtime'
import { useWorkbenchNavigation } from '../workbench/context'

type HomeApp = Readonly<{
	key: string
	label: string
	owner: string
	standalone: boolean
	href: string
	/** The entry's Workbench group, shared by entries of several plugins that belong together. */
	group?: Readonly<{ id: string; label: string }>
}>

/** Ungrouped shortcuts first, then one block per group, in first-seen order. */
export function groupApps(
	apps: readonly HomeApp[],
): Array<Readonly<{ id: string; label: string | null; apps: HomeApp[] }>> {
	const blocks = new Map<string, { id: string; label: string | null; apps: HomeApp[] }>()
	blocks.set('', { id: '', label: null, apps: [] })
	for (const app of apps) {
		const id = app.group?.id ?? ''
		const block = blocks.get(id) ?? { id, label: app.group?.label ?? null, apps: [] }
		block.apps.push(app)
		blocks.set(id, block)
	}
	return [...blocks.values()].filter((block) => block.apps.length > 0)
}

/** Published page entries as one-click shortcuts; parameterised routes go through the apps page. */
export function HomeApps() {
	const navigation = useWorkbenchNavigation()
	const snapshot = useWorkbenchTargetSnapshot(null)
	const apps = useMemo(() => {
		const routes = snapshot.directory.routes
		return (snapshot.layout?.entries ?? []).flatMap((entry): HomeApp[] => {
			const placement = entry.placement
			if (placement.kind === 'tab')
				return [
					{
						key: `${buildPluginDetailHref(entry.target.node)}:${entry.descriptor.key}`,
						label: placement.label ?? entry.descriptor.key,
						owner: entry.target.displayName,
						standalone: false,
						href: `${buildPluginDetailHref(entry.target.node)}?entry=${encodeURIComponent(entry.descriptor.key)}`,
						...(placement.group ? { group: placement.group } : {}),
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
					...(placement.navigation?.group ? { group: placement.navigation.group } : {}),
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
			{groupApps(apps).map((block) => (
				<div key={block.id} className="plx-home__appBlock">
					{block.label === null ? null : (
						<h3 className="plx-home__appGroupTitle">{block.label}</h3>
					)}
					<div className="plx-home__appGrid">
						{block.apps.map((app) => (
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
				</div>
			))}
		</section>
	)
}
