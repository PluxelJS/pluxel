import { type BuildableKV, ContainerBuilder, type Identifier } from 'diod'
import { LeanMapTracker } from './LeanMapTracker'

export type SingletonMap = Map<Identifier<unknown>, unknown>
export type DependentsMap = ReadonlyMap<Identifier<unknown>, Set<Identifier<unknown>>>

export class ExtendedContainerBuilder extends ContainerBuilder {
	public override buildables = new LeanMapTracker<BuildableKV[0], BuildableKV[1]>()

	constructor(builderSingleton: Map<Identifier<unknown>, unknown>) {
		super()
		this.builderSingletons = builderSingleton
	}
}
