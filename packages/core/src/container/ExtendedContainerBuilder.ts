import {
	type BuildOptions,
	ContainerBuilder,
	type IBuildable,
	type Identifier,
} from 'diod'
import { proxyMap } from 'valtio/utils'
import { ExtendedDIContainer } from './ExtendedDIContainer'

export class ExtendedContainerBuilder extends ContainerBuilder {
	override readonly buildables: IBuildable = proxyMap()

	// NOTE - 只在 build 后存在。
	public dependentsMap = new Map<
		Identifier<unknown>,
		Set<Identifier<unknown>>
	>()

	// NOTE - build 保证所有依赖都已经有所属，但不代表已经实例化。
	override build({ autowire = false }: BuildOptions): ExtendedDIContainer {
		const { services, dependents } = this.buildServices({
			autowire,
			verify: true,
		})
		this.dependentsMap = dependents
		return new ExtendedDIContainer(services, this.builderSingletons)
	}

	public unregisterMultipleServices<T>(identifier: Identifier<T>[]): void {
		for (const key of identifier) {
			this.unregister(key)
		}
	}

	/**
	 * ! 此方法应在不可变环境下使用
	 * 清除指定服务的单例缓存，下一次构建获取时会重新创建
	 */
	public clearSingleton<T>(identifier: Identifier<T>): void {
		const dependents = this.dependentsMap.get(identifier)
		if (!dependents) return
		for (const dep of dependents) {
			this.builderSingletons.delete(dep)
		}
		this.builderSingletons.delete(identifier)
	}

	/**
	 * 清除所有单例缓存，下一次构建时所有单例都会更新
	 */
	public refreshAllSingletons(): void {
		this.builderSingletons.clear()
	}
}
