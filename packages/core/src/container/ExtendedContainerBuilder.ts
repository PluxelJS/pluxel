import {
	type BuildOptions,
	ContainerBuilder,
	type IBuildable,
	type Identifier,
} from 'diod'
import { ExtendedDIContainer } from './ExtendedDIContainer'

export type SingletonMap = Map<Identifier<unknown>, unknown>
export type DependentsMap = ReadonlyMap<
	Identifier<unknown>,
	Set<Identifier<unknown>>
>

export class ExtendedContainerBuilder extends ContainerBuilder {
	public override buildables: IBuildable = new Map()

	override unregister<T>(identifier: Identifier<T>): void {
		super.unregister(identifier)
		this.builderSingletons.delete(identifier)
	}

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

	public unregisterMultipleServices<T>(identifier: Identifier<T>[]): void {
		for (const key of identifier) {
			this.unregister(key)
		}
	}
}
