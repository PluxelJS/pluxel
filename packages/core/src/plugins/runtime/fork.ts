// fork.ts
// Runtime forking for plugins.
//
// A fork is a lightweight subclass (ForkCtor) that:
// - has its own DI key and isolated Context;
// - reuses all definition metadata of the original plugin ctor;
// - overrides identity to keep config/logging separate.
//
// Forking is **strict opt‑in**: only ctors extending ForkablePlugin can be forked.

import { ForkablePlugin } from '../composition/BasePlugin'
import { clonePluginDefinition, getPluginInfo } from '../decorators/PluginDecorator'
import type { ForkablePluginConstructor, PluginConstructor, PluginIdentifier } from '../types'
import { formatForkPluginId } from './pluginId'

const FORK_ID = Symbol.for('pluxel:plugin:forkId')
const FORK_OF = Symbol.for('pluxel:plugin:forkOf')

type ForkTable = WeakMap<PluginIdentifier, Map<string, PluginIdentifier>>
const forks: ForkTable = new WeakMap()

function assertForkable(ctor: PluginIdentifier): asserts ctor is ForkablePluginConstructor {
	if (!(ctor.prototype instanceof ForkablePlugin)) {
		const ctorName = (ctor as { readonly name?: string }).name
		throw new Error(
			`Plugin ${ctorName || '<anonymous>'} is not forkable. Extend ForkablePlugin to opt‑in.`,
		)
	}
}

export function forkPlugin<T extends ForkablePluginConstructor>(
	ctor: T,
	forkId: string,
): PluginConstructor {
	assertForkable(ctor)
	if (!forkId) throw new Error('forkId is required')

	let map = forks.get(ctor)
	if (!map) {
		map = new Map()
		forks.set(ctor, map)
	}

	const existing = map.get(forkId)
	if (existing) return existing as PluginConstructor

	// Create a minimal subclass used only as a DI key.
	const Base = ctor as unknown as new (...args: any[]) => ForkablePlugin
	const ForkCtor = class extends Base {} as unknown as PluginConstructor

	const info = getPluginInfo(ctor)
	const id = formatForkPluginId(info.id, forkId)
	clonePluginDefinition(ctor, ForkCtor, { id, displayName: id, packageName: info.packageName })

	Object.defineProperty(ForkCtor, FORK_ID, { value: forkId, enumerable: false })
	Object.defineProperty(ForkCtor, FORK_OF, { value: ctor, enumerable: false })

	map.set(forkId, ForkCtor)
	return ForkCtor
}

export function getForkedCtor<T extends PluginIdentifier>(
	ctor: T,
	forkId: string,
): PluginConstructor | undefined {
	return (forks.get(ctor)?.get(forkId) as PluginConstructor | undefined) ?? undefined
}

export function listForks<T extends PluginIdentifier>(ctor: T): PluginConstructor[] {
	const map = forks.get(ctor)
	return map ? ([...map.values()] as PluginConstructor[]) : []
}

export function getForkId(ctor: PluginIdentifier): string | undefined {
	return (ctor as unknown as { [FORK_ID]?: string })[FORK_ID]
}

export function getForkOf(ctor: PluginIdentifier): PluginIdentifier | undefined {
	return (ctor as unknown as { [FORK_OF]?: PluginIdentifier })[FORK_OF]
}
