import {
	type BuildOptions,
	type BuildableKV,
	ContainerBuilder,
	DiodRegistration,
	type Identifier,
	type Registration,
} from 'diod'
import { LeanMapTracker } from './LeanMapTracker'

export type SingletonMap = Map<Identifier<unknown>, unknown>
export type DependentsMap = ReadonlyMap<
	Identifier<unknown>,
	Set<Identifier<unknown>>
>

export class ExtendedContainerBuilder extends ContainerBuilder {
	public override buildables = new LeanMapTracker<
		BuildableKV[0],
		BuildableKV[1]
	>()

	constructor(builderSingleton: Map<Identifier<unknown>, unknown>) {
		super()
		this.builderSingletons = builderSingleton
	}

	dispatchReload(key: any) {
		const value = this.buildables.get(key)
		if (value === undefined) throw new Error('不能 reload 不存在的 key。')
		this.buildables.set(key, value)
	}
}
