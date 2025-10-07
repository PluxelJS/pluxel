import type { PluginDependency } from '../../gqty'
import type { PluginDependencySnapshot } from './context'

const EMPTY_DEPS = Object.freeze([]) as readonly PluginDependencySnapshot[]

export function toDependencySnapshots(
	deps: PluginDependency[] | null | undefined,
): readonly PluginDependencySnapshot[] {
	if (!deps?.length) return EMPTY_DEPS

	const mapped = deps.filter(Boolean).map((dep) => ({
		name: dep?.name ?? '',
		optional: Boolean(dep?.optional),
		isRunning: Boolean(dep?.isRunning),
	}))

	return mapped.length ? (Object.freeze(mapped) as readonly PluginDependencySnapshot[]) : EMPTY_DEPS
}

export { EMPTY_DEPS as EMPTY_DEPENDENCIES }
