import {
	type BuildOptions,
	ContainerBuilder,
	type IBuildable,
	type Identifier,
} from 'diod'
import { proxyMap } from 'valtio/utils'
import { ExtendedDIContainer } from './ExtendedDIContainer'

export type SingletonMap = Map<Identifier<unknown>, unknown>
export type DependentsMap = ReadonlyMap<
	Identifier<unknown>,
	Set<Identifier<unknown>>
>

export class ExtendedContainerBuilder extends ContainerBuilder {
	public override buildables: IBuildable = new Map()

	// NOTE - 只在 build 后存在。
	public dependentsMap: DependentsMap = new Map()
	get dependents(): DependentsMap {
		return this.dependentsMap
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
		this.dependentsMap = dependents
		return new ExtendedDIContainer(
			services,
			outsideSingletons || this.builderSingletons,
		)
	}

	public unregisterMultipleServices<T>(identifier: Identifier<T>[]): void {
		for (const key of identifier) {
			this.unregister(key)
		}
	}
}
