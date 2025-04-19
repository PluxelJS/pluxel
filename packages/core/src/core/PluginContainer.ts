import {
	ExtendedContainerBuilder,
	type ExtendedDIContainer,
	type Identifier,
	type Newable,
	ServiceVerificationAggregateError,
	type SingletonMap,
} from '@/container'
import { create } from 'mutative'
import { inspectNullable } from 'option-t/nullable'
import type { VerificationError } from '../../../diod/src/verifier'
import type { GlobalPluginContext } from './GlobalContext'
import type { BasePlugin } from './PluginBase'
import {
	CALLER_CTX,
	type PluginContext,
	createPluginContext,
} from './PluginContext'
import {
	OPTIONAL_PARAMS_KEY,
	PARAM_TYPES,
	PLUGIN_META_KEY,
	type PluginMetadata,
} from './PluginDecorator'
import { type PluginClass, type Result, createErr, createOk } from './types'

function markBuilder(target: unknown) {
	if (target instanceof ExtendedContainerBuilder) {
		// 这里直接在闭包里捕获 target
		return () => {
			const clone = new ExtendedContainerBuilder()
			// 强制塞入原实例的两个 Map
			clone.buildables = target.buildables
			clone.builderSingletons = target.builderSingletons
			return clone
		}
	}
	return undefined
}

export class PluginContainer {
	// 当前已提交状态
	private currentBuilder: ExtendedContainerBuilder =
		new ExtendedContainerBuilder()

	private draftBuilder: ExtendedContainerBuilder
	private finalize: () => ExtendedContainerBuilder

	private pluginSingletons: SingletonMap = new Map()

	private isPluginListChanged = false

	public resetDraft() {
		;[this.draftBuilder, this.finalize] = create(this.currentBuilder, {
			mark: markBuilder,
		})
	}

	constructor(private globalCtx: GlobalPluginContext) {
		;[this.draftBuilder, this.finalize] = create(this.currentBuilder, {
			mark: markBuilder,
		})
	}

	/**
	 * 给依赖注入用：把 callerContext 绑定到 proxy，
	 * 后续被依赖对象用 this[CALLER_CTX] 就能拿到。
	 */
	private injectCallerContext<T extends BasePlugin>(
		dep: T,
		callerCtx: PluginContext,
	): T {
		return new Proxy(dep, {
			get(target, prop, receiver) {
				const v = Reflect.get(target, prop, receiver)
				if (typeof v !== 'function') return v
				// biome-ignore lint/suspicious/noExplicitAny: <explanation>
				return (...args: any[]) => {
					// 注入 callerContext
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					;(target as any)[CALLER_CTX] = callerCtx
					try {
						return v.apply(target, args)
					} finally {
						// biome-ignore lint/suspicious/noExplicitAny: <explanation>
						delete (target as any)[CALLER_CTX]
					}
				}
			},
		}) as T
	}

	public registerPlugin(PluginClass: PluginClass): void {
		const meta = Reflect.getMetadata(
			PLUGIN_META_KEY,
			PluginClass,
		) as PluginMetadata
		if (!meta) {
			throw new Error(
				'Plugin metadata is missing. Ensure @Plugin decorator is applied.',
			)
		}

		this.isPluginListChanged = true
		this.draftBuilder
			.register(PluginClass)
			.useFactory((c) => {
				// biome-ignore lint/suspicious/noExplicitAny: <explanation>
				const paramTypes: any[] =
					Reflect.getMetadata(PARAM_TYPES, PluginClass) || []
				this.globalCtx.logger.info(
					`Param types for ${PluginClass.name}: ${paramTypes
						.map((t) => t.name)
						.join(', ')}`,
				)
				const optionalParams: number[] =
					Reflect.getOwnMetadata(OPTIONAL_PARAMS_KEY, PluginClass) || []

				const pluginCtx = createPluginContext(meta, this.globalCtx)
				const dependencies = paramTypes.map((depType, index) => {
					if (optionalParams.includes(index)) {
						try {
							const optionalDep = c.get(depType)

							return this.injectCallerContext(
								optionalDep as BasePlugin,
								pluginCtx,
							)
						} catch (_e) {
							return undefined
						}
					} else {
						// 必然存在，如果不存在 build 的时候都不会成功，无法到达 factory 这。
						const dep = c.get(depType)
						return this.injectCallerContext(dep as BasePlugin, pluginCtx)
					}
				})
				const ins = new PluginClass(...dependencies)
				ins.setContext(pluginCtx)
				return ins
			})
			.asBuilderSingleton()
	}

	public unregisterPlugin(PluginClass: PluginClass): void {
		this.isPluginListChanged = true
		this.draftBuilder.unregister(PluginClass)
	}

	public reloadPlugin(PluginClass: PluginClass) {
		const reinitList: Identifier<unknown>[] = []
		this.pluginSingletons.delete(PluginClass)
		const dependents = this.currentBuilder.dependents.get(PluginClass)
		if (dependents) {
			for (const dep of dependents) {
				this.pluginSingletons.delete(dep)
				reinitList.push(dep)
			}
		}

		if (!this.isPluginListChanged) {
			return reinitList as PluginClass[]
		}
		return this.commit()
	}

	public commit(): Result<ExtendedDIContainer, VerificationError[]> {
		try {
			// 此处会验证 draftBuilder 的所有定义依赖是否都存在。
			const container = this.draftBuilder.build({
				outsideSingletons: this.pluginSingletons,
			})
			this.currentBuilder = this.finalize()
			this.resetDraft()
			return createOk(container)
		} catch (err) {
			if (err instanceof ServiceVerificationAggregateError) {
				return createErr(err.errors)
			}
			throw err
		}
	}
}
