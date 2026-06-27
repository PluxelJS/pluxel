import type { PluginIdentifier } from '../../types'

export type RuntimeDependencyOverrideList = readonly (PluginIdentifier | undefined)[]
export type RuntimeDependencyOverrideSnapshot = Map<
	string,
	RuntimeDependencyOverrideList | undefined
>

export class RuntimeDependencyOverrides {
	private readonly values = new Map<string, RuntimeDependencyOverrideList>()

	public get(pluginId: string): RuntimeDependencyOverrideList | undefined {
		return this.values.get(pluginId)
	}

	public replace(
		pluginId: string,
		overrides: RuntimeDependencyOverrideList | undefined,
	): {
		changed: boolean
		previous: RuntimeDependencyOverrideList | undefined
	} {
		const previous = this.values.get(pluginId)
		const next = normalizeRuntimeDependencyOverrides(overrides)
		if (sameRuntimeDependencyOverrides(previous, next)) {
			return { changed: false, previous }
		}

		if (!next) this.values.delete(pluginId)
		else this.values.set(pluginId, next)

		return { changed: true, previous }
	}

	public restore(snapshots: ReadonlyMap<string, RuntimeDependencyOverrideList | undefined>): void {
		for (const [pluginId, previous] of snapshots) {
			if (!previous) this.values.delete(pluginId)
			else this.values.set(pluginId, previous)
		}
	}
}

function normalizeRuntimeDependencyOverrides(
	overrides: RuntimeDependencyOverrideList | undefined,
): RuntimeDependencyOverrideList | undefined {
	if (!overrides || overrides.length === 0) return undefined
	let end = overrides.length
	while (end > 0 && overrides[end - 1] === undefined) end--
	if (end === 0) return undefined
	const next = Array<PluginIdentifier | undefined>(end)
	for (let i = 0; i < end; i++) next[i] = overrides[i]
	return next
}

function sameRuntimeDependencyOverrides(
	left: RuntimeDependencyOverrideList | undefined,
	right: RuntimeDependencyOverrideList | undefined,
): boolean {
	if (!left || left.length === 0) return !right || right.length === 0
	if (!right || right.length === 0) return false
	if (left.length !== right.length) return false
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false
	}
	return true
}
