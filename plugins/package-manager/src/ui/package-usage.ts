import type { PluginStatusSnapshot } from '@pluxel/services/management/client'
import type { WorkbenchHostFacade } from '@pluxel/workbench/react'

type PackagePlugin = Readonly<
	Pick<PluginStatusSnapshot, 'route' | 'lifecycleState' | 'availability' | 'activationReason'> & {
		label: string
	}
>

export type PackageUsage = Readonly<{ name: string; plugins: readonly PackagePlugin[] }>

/** Group reported nodes by their declared npm identity. A host observation has no installed version. */
export async function readPackageUsage({
	management,
}: Pick<WorkbenchHostFacade, 'management'>): Promise<readonly PackageUsage[] | null> {
	if (!management) return null
	const catalog = await management.catalog.snapshot()
	const packages = new Map<string, PackagePlugin[]>()
	for (const {
		address,
		label,
		route,
		lifecycleState,
		availability,
		activationReason,
	} of catalog.plugins) {
		const { entry } = address.definition
		if (entry.kind === 'source-entry') continue
		const plugin = { label: label.text, route, lifecycleState, availability, activationReason }
		const group = packages.get(entry.packageName)
		if (group) group.push(plugin)
		else packages.set(entry.packageName, [plugin])
	}
	return Array.from(packages, ([name, plugins]) => ({ name, plugins })).sort((a, b) =>
		a.name.localeCompare(b.name),
	)
}
