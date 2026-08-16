import type { PluginIdentifier } from '../types'

const FORK_ID = Symbol.for('pluxel:plugin:forkId')
const FORK_OF = Symbol.for('pluxel:plugin:forkOf')

export function markFork(ctor: PluginIdentifier, base: PluginIdentifier, forkId: string): void {
	Object.defineProperty(ctor, FORK_ID, { value: forkId, enumerable: false })
	Object.defineProperty(ctor, FORK_OF, { value: base, enumerable: false })
}

export function getForkId(ctor: PluginIdentifier): string | undefined {
	return (ctor as unknown as { [FORK_ID]?: string })[FORK_ID]
}

export function getForkOf(ctor: PluginIdentifier): PluginIdentifier | undefined {
	return (ctor as unknown as { [FORK_OF]?: PluginIdentifier })[FORK_OF]
}
