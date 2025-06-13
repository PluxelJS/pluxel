import {
	type BuildOptions,
	type BuildableKV,
	ContainerBuilder,
	DiodRegistration,
	type Identifier,
	type Registration,
} from 'diod'
import { ExtendedDIContainer } from './ExtendedDIContainer'
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

	// NOTE - build 保证所有依赖都已经有所属，但不代表已经实例化。
	override build({
		autowire = false,
		outsideSingletons,
	}: BuildOptions & {
		outsideSingletons?: SingletonMap
	} = {}): ExtendedDIContainer {
		const { services, dependents } = this.buildServices({
			autowire,
			verify: true,
		})
		return new ExtendedDIContainer(
			services as any,
			dependents as any,
			(outsideSingletons || this.builderSingletons) as any,
		)
	}

	public override register<T>(identifier: Identifier<T>): Registration<T> {
		const buildable = DiodRegistration.createBuildable(identifier)
		this.buildables.set(identifier, buildable)
		return buildable.instance
	}
}
