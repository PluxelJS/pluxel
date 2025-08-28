// container.ts

import type { Maybe } from 'option-t/maybe'
import { createErr, createOk, isOk, type Result } from 'option-t/plain_result'
import type { ServiceData } from './internal-types'
import {
	type AliasKey,
	type Container,
	type Identifier,
	RegistrationType,
	type ScopedContainer,
	ScopeType,
} from './types'

/* ----------------------------------------------------------------------------
 * 运行期解析错误（Container 返回 Result/Maybe 用）
 * 统一使用 Identifier；NotRegistered 允许 AliasKey（别名查找失败）
 * ------------------------------------------------------------------------- */
export type ResolveError =
	| { kind: 'NotRegistered'; id: Identifier<unknown> | AliasKey }
	| { kind: 'PrivateService'; id: Identifier<unknown> }
	| { kind: 'CircularDependency'; chain: Identifier<unknown>[] }
	| { kind: 'FactoryError'; id: Identifier<unknown>; cause: unknown }

export type ContainerAccessors = {
	getResult<T>(id: Identifier<T>): Result<T, ResolveError>
	get<T>(id: Identifier<T>): Maybe<T>
	getMaybe<T>(id: Identifier<T>): Maybe<T>
	getByAliasResult<T = unknown>(alias: AliasKey): Result<T, ResolveError>
	getByAlias<T = unknown>(alias: AliasKey): Maybe<T>
}

export class DiodContainer<U = unknown> implements Container {
	private readonly singletons = new Map<Identifier<unknown>, unknown>()
	private readonly builderSingletons: Map<Identifier<unknown>, unknown>
	private readonly tagIndex = new Map<string, Identifier<unknown>[]>()
	private readonly aliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>

	public constructor(
		public readonly services: ReadonlyMap<Identifier<U>, ServiceData<U>>,
		public readonly dependents: ReadonlyMap<Identifier<U>, Set<Identifier<U>>>,
		builderSingletons: Map<Identifier<U>, U>,
		aliasIndex: ReadonlyMap<AliasKey, Identifier<U>>,
	) {
		this.builderSingletons = builderSingletons
		this.aliasIndex = aliasIndex

		// 预建 tag 索引（O(1) 查询）
		for (const [id, meta] of services) {
			const tags = meta.tags
			if (!tags || tags.length === 0) continue
			for (let i = 0; i < tags.length; i++) {
				const tag = tags[i]!
				const existed = this.tagIndex.get(tag)
				if (existed) existed.push(id)
				else this.tagIndex.set(tag, [id])
			}
		}
	}

	/* ------------------------------ Public API ------------------------------- */

	public getResult<T>(identifier: Identifier<T>): Result<T, ResolveError> {
		return this.newRootAccessors().getResult(identifier)
	}
	public get<T>(identifier: Identifier<T>): Maybe<T> {
		return this.newRootAccessors().get(identifier)
	}
	public getMaybe<T>(identifier: Identifier<T>): Maybe<T> {
		return this.newRootAccessors().getMaybe(identifier)
	}

	public getByAliasResult<T = unknown>(
		alias: AliasKey,
	): Result<T, ResolveError> {
		return this.newRootAccessors().getByAliasResult(alias)
	}
	public getByAlias<T = unknown>(alias: AliasKey): Maybe<T> {
		return this.newRootAccessors().getByAlias(alias)
	}

	public findTaggedServiceIdentifiers<T = unknown>(
		tag: string,
	): Identifier<T>[] {
		return (this.tagIndex.get(tag) ?? []) as Identifier<T>[]
	}

	public beginScope(): ScopedContainer {
		const perRequest = new Map<Identifier<unknown>, unknown>()
		const visiting = new Set<Identifier<unknown>>()
		const path: Identifier<unknown>[] = []

		const acc = this.makeAccessors(perRequest, visiting, path, false)
		return {
			getResult: acc.getResult,
			getMaybe: acc.getMaybe,
			get: acc.get,
			getByAliasResult: acc.getByAliasResult,
			getByAlias: acc.getByAlias,
			dispose: () => {
				// 如需 onDispose/AsyncDispose，可在此集中回收
			},
		}
	}

	/* ------------------------------- Internals -------------------------------- */

	private newRootAccessors(): ContainerAccessors {
		const perRequest = new Map<Identifier<unknown>, unknown>()
		const visiting = new Set<Identifier<unknown>>()
		const path: Identifier<unknown>[] = []
		return this.makeAccessors(perRequest, visiting, path, false)
	}

	private makeAccessors(
		perRequest: Map<Identifier<unknown>, unknown>,
		visiting: Set<Identifier<unknown>>,
		path: Identifier<unknown>[],
		isDependency: boolean,
	): ContainerAccessors {
		const getResult = <T>(id: Identifier<T>) =>
			this.resolveServiceResult(id, perRequest, isDependency, visiting, path)

		const toMaybe = <T>(r: Result<T, ResolveError>): Maybe<T> =>
			isOk(r) ? (r.val as Maybe<T>) : (undefined as Maybe<T>)

		const getByAliasResult = <T = unknown>(
			alias: AliasKey,
		): Result<T, ResolveError> => {
			const id = this.aliasIndex.get(alias)
			if (!id) return createErr({ kind: 'NotRegistered', id: alias as any })
			// 别名属于“直接获取”，应用 private 限制（isDependency=false）
			return this.resolveServiceResult(
				id as Identifier<T>,
				perRequest,
				false,
				visiting,
				path,
			)
		}

		return {
			getResult,
			getMaybe: <T>(id: Identifier<T>) => toMaybe(getResult(id)),
			get: <T>(id: Identifier<T>) => toMaybe(getResult(id)),
			getByAliasResult,
			getByAlias: <T = unknown>(alias: AliasKey) =>
				toMaybe(getByAliasResult<T>(alias)),
		}
	}

	private resolveServiceResult<T>(
		identifier: Identifier<T>,
		perRequestServices: Map<Identifier<unknown>, unknown>,
		isDependency: boolean,
		visiting: Set<Identifier<unknown>>,
		path: Identifier<unknown>[],
	): Result<T, ResolveError> {
		const meta = this.lookupService(identifier, isDependency)
		if (!isOk(meta)) return meta

		const cached = this.tryGetCachedInstance(
			identifier,
			meta.val.scope,
			perRequestServices,
		)
		if (cached !== undefined) return createOk(cached as T)

		if (visiting.has(identifier)) {
			return createErr({
				kind: 'CircularDependency',
				chain: [...path, identifier],
			})
		}

		visiting.add(identifier)
		path.push(identifier)

		const created = this.createInstanceResult(
			identifier,
			meta.val,
			perRequestServices,
			visiting,
			path,
		)

		path.pop()
		visiting.delete(identifier)

		if (!isOk(created)) return created
		this.cacheInstance(
			identifier,
			created.val,
			meta.val.scope,
			perRequestServices,
		)
		return created
	}

	private tryGetCachedInstance<T>(
		identifier: Identifier<T>,
		scope: ScopeType,
		perRequestServices: Map<Identifier<unknown>, unknown>,
	): T | undefined {
		switch (scope) {
			case ScopeType.Builder_Singleton:
				return this.builderSingletons.get(identifier) as T
			case ScopeType.Singleton:
				return this.singletons.get(identifier) as T
			case ScopeType.Request:
				return perRequestServices.get(identifier) as T
			default:
				return undefined // Transient：不缓存
		}
	}

	private createInstanceResult<T>(
		identifier: Identifier<T>,
		data: ServiceData<T>,
		perRequestServices: Map<Identifier<unknown>, unknown>,
		visiting: Set<Identifier<unknown>>,
		path: Identifier<unknown>[],
	): Result<T, ResolveError> {
		try {
			switch (data.type) {
				case RegistrationType.Instance:
					return createOk(data.instance as T)
				case RegistrationType.Class: {
					const n = data.dependencies.length
					const deps: unknown[] = new Array(n)
					for (let i = 0; i < n; i++) {
						const dep = data.dependencies[i]!
						const r = this.resolveServiceResult(
							dep,
							perRequestServices,
							true,
							visiting,
							path,
						)
						if (!isOk(r)) return r as Result<T, ResolveError>
						deps[i] = r.val
					}
					// biome-ignore lint/suspicious/noExplicitAny: ctor newable
					return createOk(new (data.class as any)(...deps))
				}
				case RegistrationType.Factory: {
					// Factory 内部解析视为依赖（isDependency=true）
					const accDep = this.makeAccessors(
						perRequestServices,
						visiting,
						path,
						true,
					)
					const ctx = {
						...accDep,
						findTaggedServiceIdentifiers: <U = unknown>(tag: string) =>
							this.findTaggedServiceIdentifiers<U>(tag),
					}

					try {
						const produced = data.factory(ctx) as T
						if (produced === undefined || produced === null) {
							return createErr({
								kind: 'FactoryError',
								id: identifier,
								cause: new Error('Factory returned null/undefined'),
							})
						}
						return createOk(produced)
					} catch (e) {
						return createErr({ kind: 'FactoryError', id: identifier, cause: e })
					}
				}

				default:
					return createErr({
						kind: 'FactoryError',
						id: identifier,
						cause: new Error('Unknown registration type'),
					})
			}
		} catch (cause) {
			return createErr({ kind: 'FactoryError', id: identifier, cause })
		}
	}

	private cacheInstance<T>(
		identifier: Identifier<T>,
		instance: T,
		scope: ScopeType,
		perRequestServices: Map<Identifier<unknown>, unknown>,
	): void {
		switch (scope) {
			case ScopeType.Singleton:
				this.singletons.set(identifier, instance)
				break
			case ScopeType.Request:
				perRequestServices.set(identifier, instance)
				break
			case ScopeType.Builder_Singleton:
				this.builderSingletons.set(identifier, instance)
				break
			// Transient：不缓存
		}
	}

	private lookupService<T>(
		identifier: Identifier<T>,
		isDependency: boolean,
	): Result<ServiceData<T>, ResolveError> {
		const svc = this.services.get(identifier)
		if (!svc) return createErr({ kind: 'NotRegistered', id: identifier })
		if (!isDependency && svc.isPrivate)
			return createErr({ kind: 'PrivateService', id: identifier })
		return createOk(svc as ServiceData<T>)
	}
}
