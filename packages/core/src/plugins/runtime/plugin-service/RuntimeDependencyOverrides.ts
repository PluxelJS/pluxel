import type { PluginDefinitionSlot, PluginNodeSlot } from '../identity'

export type RuntimeDependencyOverride = PluginDefinitionSlot | PluginNodeSlot | undefined
export type RuntimeDependencyOverrideList = readonly RuntimeDependencyOverride[]
export type RuntimeDependencyOverrideSnapshot = Map<
	PluginNodeSlot,
	RuntimeDependencyOverrideList | undefined
>

export class RuntimeDependencyOverrides {
	private readonly values = new Map<PluginNodeSlot, RuntimeDependencyOverrideList>()

	get(consumer: PluginNodeSlot): RuntimeDependencyOverrideList | undefined {
		return this.values.get(consumer)
	}

	replace(
		consumer: PluginNodeSlot,
		overrides: RuntimeDependencyOverrideList | undefined,
	): { changed: boolean; previous: RuntimeDependencyOverrideList | undefined } {
		const previous = this.values.get(consumer)
		const next = normalize(overrides)
		if (same(previous, next)) return { changed: false, previous }
		if (next) this.values.set(consumer, next)
		else this.values.delete(consumer)
		return { changed: true, previous }
	}

	restore(snapshots: ReadonlyMap<PluginNodeSlot, RuntimeDependencyOverrideList | undefined>): void {
		for (const [consumer, previous] of snapshots) {
			if (previous) this.values.set(consumer, previous)
			else this.values.delete(consumer)
		}
	}
}

function normalize(
	value: RuntimeDependencyOverrideList | undefined,
): RuntimeDependencyOverrideList | undefined {
	if (!value?.length) return undefined
	let end = value.length
	while (end > 0 && value[end - 1] === undefined) end--
	return end === 0 ? undefined : Object.freeze(value.slice(0, end))
}

function same(
	left: RuntimeDependencyOverrideList | undefined,
	right: RuntimeDependencyOverrideList | undefined,
): boolean {
	if (!left) return !right
	if (!right || left.length !== right.length) return false
	for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
	return true
}
