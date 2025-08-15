// types.ts
import type { Maybe } from 'option-t/maybe'
import type { Result } from 'option-t/plain_result'
import type { ResolveError } from '../container'
/** 可 new 的类 */
export type Newable<T> = new (...args: any[]) => T
/** 抽象类 */
export type Abstract<T> = abstract new (...args: any[]) => T
/** 服务标识（具体类或抽象类） */
export type Identifier<T> = Newable<T> | Abstract<T>

/** Alias 键类型（支持 symbol，避免字符串冲突） */
export type AliasKey = string | symbol | Abstract<any>

/** 别名冲突策略（构建期选择） */
export type AliasConflictPolicy = 'error' | 'firstWins' | 'lastWins'

/** 构建选项 */
export type BuildOptions = {
	/** 是否按类型元数据自动注入依赖。默认 true */
	autowire?: boolean
	/** 别名冲突策略。默认 'error' */
	aliasPolicy?: AliasConflictPolicy
}

/** Factory 调用上下文（Result/Maybe 风格，无异常流控） */
export type FactoryContext = {
	getResult<T>(id: Identifier<T>): Result<T, ResolveError>
	getMaybe<T>(id: Identifier<T>): Maybe<T>
	get<T>(identifier: Identifier<T>): Maybe<T>
	getByAliasResult<T = unknown>(alias: AliasKey): Result<T, ResolveError>
	getByAlias<T = unknown>(alias: AliasKey): Maybe<T>
	findTaggedServiceIdentifiers<T = unknown>(tag: string): Identifier<T>[]
}

/** Factory 返回 Result，避免 (id)=>T 的抛错耦合 */
export type Factory<T> = (ctx: FactoryContext) => T

/** 实例可为任意对象 */
export type Instance<T> = T & Object

/* ----------------------------------------------------------------------------
 * Container interfaces（纯 Result/Maybe 风格）
 * ------------------------------------------------------------------------- */

export interface Container {
	getResult<T>(identifier: Identifier<T>): Result<T, ResolveError>
	getMaybe<T>(identifier: Identifier<T>): Maybe<T>
	get<T>(identifier: Identifier<T>): Maybe<T>
	/** 别名解析（受 private 限制） */
	getByAliasResult<T = unknown>(alias: AliasKey): Result<T, ResolveError>
	getByAlias<T = unknown>(alias: AliasKey): Maybe<T>

	findTaggedServiceIdentifiers<T = unknown>(tag: string): Identifier<T>[]
	beginScope(): ScopedContainer
}

export interface ScopedContainer {
	getResult<T>(identifier: Identifier<T>): Result<T, ResolveError>
	getMaybe<T>(identifier: Identifier<T>): Maybe<T>
	get<T>(identifier: Identifier<T>): Maybe<T>

	getByAliasResult<T = unknown>(alias: AliasKey): Result<T, ResolveError>
	getByAlias<T = unknown>(alias: AliasKey): Maybe<T>

	dispose(): void | Promise<void>
}

/* ----------------------------------------------------------------------------
 * Registration fluent types
 * ------------------------------------------------------------------------- */

export interface ConfigurableRegistration {
	public(): this
	private(): this
	addTag(tag: string): this
	/** 为服务添加别名（一个服务可多个别名） */
	addAlias(alias: AliasKey): this
}

export interface WithScopeChange {
	asTransient(): this
	asSingleton(): this
	asInstancePerRequest(): this
	asBuilderSingleton(): this
}

export interface WithDependencies {
	/** 显式声明构造函数/工厂依赖（按顺序） */
	withDependencies(dependencies: Identifier<unknown>[]): this
}

export interface Registration<T> {
	useClass(
		newable: Newable<T>,
	): ConfigurableRegistration & WithScopeChange & WithDependencies
	/** 等价别名 */
	use(
		newable: Newable<T>,
	): ConfigurableRegistration & WithScopeChange & WithDependencies
	useInstance(instance: Instance<T>): ConfigurableRegistration
	useFactory(
		factory: Factory<T>,
	): ConfigurableRegistration & WithScopeChange & WithDependencies
}
