// builder.ts
// Goals:
// - Result-first core (no throw inside hot path)
// - Thin throwing wrappers for fluent DX (register().use())
// - Per-service dirty set (incremental rebuild for metadata/validation)
// - Incremental verify/dependents fast-path for small deltas (aliasPolicy='error')
// - Idempotent unregister()

import { createErr, createOk, isOk, type Result } from 'option-t/plain_result'
import {
	computeAliasIndex,
	computeAliasIndexErrorIncremental,
} from './builder/alias-index'
import {
	applyDependentsDelta,
	computeAffectedDependents,
} from './builder/dependents-delta'
import { DiodContainer } from './container'
import type { Buildable, ServiceData } from './internal-types'
import { DiodRegistration } from './registration'
import type {
	AliasConflictPolicy,
	AliasKey,
	BuildOptions,
	ConfigurableRegistration,
	Identifier,
	Newable,
	Registration,
	WithDependencies,
	WithScopeChange,
} from './types'
import {
	ServiceVerificationAggregateError,
	type VerificationError,
	validateServicesSubset,
	verifyAndComputeDependents,
} from './verifier'

/* --------------------------------- Types ---------------------------------- */

type BuildableKV<T = unknown> = [Identifier<T>, Buildable<Registration<T>, T>]
type IBuildable = Map<BuildableKV[0], BuildableKV[1]>
type ServiceMap<T = unknown> = Map<Identifier<T>, ServiceData<T>>

export { DiodRegistration }
export type { BuildableKV, IBuildable, ServiceData, ServiceMap }

export type RegistryError =
	| { kind: 'AlreadyRegistered'; id: Identifier<unknown> }
	| { kind: 'NotRegistered'; id: Identifier<unknown> }
	| { kind: 'Frozen' }

/* ------------------------------- Builder Core ------------------------------ */

export class ContainerBuilder {
	/**
	 * Underlying registry map.
	 * - Default: plain Map
	 * - Core may override (e.g. LeanMapTracker) to support draft/commit semantics.
	 */
	public buildables: IBuildable = new Map()

	/** 构建期与惰性创建的 Builder_Singleton 实例缓存 */
	public builderSingletons: Map<Identifier<unknown>, unknown> = new Map()

	/* ---------------------------- simple cache line --------------------------- */
	private _dirty = true
	private readonly _dirtyIds = new Set<Identifier<unknown>>()
	private _forceFullRebuild = true
	private _lastAutowire: boolean | undefined
	private _lastAliasPolicy: AliasConflictPolicy | undefined
	private _servicesCache?: Map<Identifier<unknown>, ServiceData<unknown>>
	private _dependentsCache?: Map<Identifier<unknown>, Set<Identifier<unknown>>>
	private _aliasIndexCache?: Map<AliasKey, Identifier<unknown>>
	private _errorsCache?: ServiceVerificationAggregateError
	private _lastBuildOk = false
	private _frozen = false

	private static freezeMeta(data: ServiceData<unknown>): ServiceData<unknown> {
		Object.freeze(data.tags)
		Object.freeze(data.aliases)
		Object.freeze(data.dependencies)
		return Object.freeze(data)
	}

	private markDirty(id?: Identifier<unknown>): void {
		this._dirty = true
		if (id) {
			this._forceFullRebuild = false
			this._dirtyIds.add(id)
		} else {
			this._dirtyIds.clear()
			this._forceFullRebuild = true
			// unknown/bulk changes: baseline caches may be invalid
			this._servicesCache = undefined
			this._dependentsCache = undefined
			this._aliasIndexCache = undefined
		}
		this._errorsCache = undefined
	}

	/** 外部 bulk 修改（如 tracker.reset）后调用，保证缓存不会“幽灵命中”。 */
	public invalidateAll(): void {
		this.markDirty()
	}

	/** 可选：构建成功后对外锁表（避免误改） */
	public freeze(): void {
		this._frozen = true
	}

	/* ------------------------------ Result 内核 ------------------------------ */

	private _tryRegisterCore<T>(
		identifier: Identifier<T>,
	): Result<Registration<T>, RegistryError> {
		if (this._frozen) return createErr({ kind: 'Frozen' })
		if (this.buildables.has(identifier)) {
			return createErr({ kind: 'AlreadyRegistered', id: identifier })
		}
		const buildable = DiodRegistration.createBuildable(identifier, (id) =>
			this.markDirty(id),
		)
		this.buildables.set(identifier, buildable)
		this._forceFullRebuild = false
		this.markDirty(identifier as Identifier<unknown>)
		return createOk(buildable.instance as Registration<T>)
	}

	private _tryUnregisterCore<T>(
		identifier: Identifier<T>,
	): Result<boolean, RegistryError> {
		if (this._frozen) return createErr({ kind: 'Frozen' })
		const existed = this.buildables.delete(identifier)
		this.builderSingletons.delete(identifier)
		if (existed) {
			this._forceFullRebuild = false
			this.markDirty(identifier as Identifier<unknown>)
		}
		// 幂等：未注册不算错误
		return createOk(existed)
	}

	/* ------------------------------- 公共 API -------------------------------- */

	/** 流式「快乐路径」：失败抛错（薄壳，仅映射 Result→throw）。 */
	public register<T>(identifier: Identifier<T>): Registration<T> {
		const r = this._tryRegisterCore(identifier)
		if (isOk(r)) return r.val
		if (r.err.kind === 'Frozen') throw new Error('Builder is frozen')
		if (r.err.kind === 'AlreadyRegistered')
			throw new Error('Already registered')
		throw new Error('Unknown registration error')
	}

	/** 安全路径：无异常。 */
	public tryRegister<T>(
		identifier: Identifier<T>,
	): Result<Registration<T>, RegistryError> {
		return this._tryRegisterCore(identifier)
	}

	/** 幂等删除：不存在返回 false，仅 Frozen 通过薄壳抛错。 */
	public unregister<T>(identifier: Identifier<T>): boolean {
		const r = this._tryUnregisterCore(identifier)
		if (isOk(r)) return r.val
		throw new Error('Builder is frozen')
	}

	public tryUnregister<T>(
		identifier: Identifier<T>,
	): Result<boolean, RegistryError> {
		return this._tryUnregisterCore(identifier)
	}

	public isRegistered<T>(identifier: Identifier<T>): boolean {
		return this.buildables.has(identifier)
	}

	public registerAndUse<T>(
		newable: Newable<T>,
	): ConfigurableRegistration & WithScopeChange & WithDependencies {
		return this.register(newable).use(newable)
	}

	public tryRegisterAndUse<T>(
		newable: Newable<T>,
	): Result<
		ConfigurableRegistration & WithScopeChange & WithDependencies,
		RegistryError
	> {
		const r = this._tryRegisterCore(newable)
		if (!isOk(r)) return r
		return createOk(r.val.use(newable))
	}

	/** 存在即取，不存在即创建；冻结时创建会抛错（直觉化） */
	public ensure<T>(identifier: Identifier<T>): Registration<T> {
		const existed = this.buildables.get(identifier)
		if (existed) return existed.instance as Registration<T>
		return this.register(identifier)
	}

	/* --------------------------- Build & Verification -------------------------- */
	// helper logic extracted to ./builder/*

	public buildServices({
		autowire = true,
		aliasPolicy = 'error',
	}: BuildOptions = {}): Result<
		{
			services: ServiceMap
			dependents: Map<Identifier<unknown>, Set<Identifier<unknown>>>
			aliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>
		},
		ServiceVerificationAggregateError
	> {
		if (
			!this._dirty &&
			this._servicesCache &&
			this._lastAutowire === autowire &&
			this._lastAliasPolicy === aliasPolicy &&
			this._aliasIndexCache
		) {
			if (this._errorsCache) return createErr(this._errorsCache)
			return createOk({
				services: this._servicesCache,
				dependents: this._dependentsCache ?? new Map(),
				aliasIndex: this._aliasIndexCache,
			})
		}

		const canIncrementalServices =
			!this._forceFullRebuild &&
			this._servicesCache &&
			this._lastAutowire === autowire &&
			this._lastAliasPolicy === aliasPolicy &&
			this._dirtyIds.size > 0

		const prevServices = this._servicesCache
		const prevAliasIndex = this._aliasIndexCache
		const prevDependents = this._dependentsCache

		const services =
			canIncrementalServices && prevServices
				? new Map(prevServices)
				: new Map<Identifier<unknown>, ServiceData<unknown>>()

		let builtErrors: VerificationError[] | undefined

		if (!canIncrementalServices || !prevServices) {
			// full rebuild
			for (const [identifier, buildable] of this.buildables) {
				try {
					const data = ContainerBuilder.freezeMeta(
						buildable.build({ autowire }) as ServiceData<unknown>,
					)
					services.set(identifier, data)
				} catch (e) {
					if (!builtErrors) builtErrors = []
					builtErrors.push({
						kind: 'InvalidRegistration',
						id: identifier,
						message: e instanceof Error ? e.message : String(e),
					})
				}
			}
		} else {
			// incremental rebuild: only dirty ids
			for (const id of this._dirtyIds) {
				const buildable = this.buildables.get(id)
				if (!buildable) {
					services.delete(id)
					continue
				}
				try {
					const data = ContainerBuilder.freezeMeta(
						buildable.build({ autowire }) as ServiceData<unknown>,
					)
					services.set(id, data)
				} catch (e) {
					if (!builtErrors) builtErrors = []
					builtErrors.push({
						kind: 'InvalidRegistration',
						id,
						message: e instanceof Error ? e.message : String(e),
					})
				}
			}
		}

		const built = { services, errors: builtErrors ?? [] }

		this._servicesCache = services
		this._lastAutowire = autowire
		this._lastAliasPolicy = aliasPolicy

		const canIncrementalAlias =
			aliasPolicy === 'error' &&
			canIncrementalServices &&
			this._lastBuildOk &&
			prevAliasIndex &&
			prevServices

		const alias = canIncrementalAlias
			? computeAliasIndexErrorIncremental(
					prevAliasIndex,
					prevServices,
					services,
					this._dirtyIds,
				)
			: computeAliasIndex(built.services, aliasPolicy)

		this._aliasIndexCache = alias.aliasIndex

		const canIncrementalVerify =
			aliasPolicy === 'error' &&
			canIncrementalAlias &&
			prevDependents &&
			prevServices &&
			prevAliasIndex &&
			this._lastBuildOk

		const incremental =
			canIncrementalVerify && prevDependents
				? (() => {
						const affected = computeAffectedDependents(
							this._dirtyIds,
							prevDependents,
						)
						const errs = validateServicesSubset(
							services,
							alias.aliasIndex,
							affected,
						)
						return { affected, errors: errs }
					})()
				: undefined

		const { dependentsMap, errors } = incremental
			? { dependentsMap: prevDependents, errors: incremental.errors }
			: verifyAndComputeDependents(built.services, alias.aliasIndex)

		const allErrors = [...built.errors, ...errors, ...alias.errors]

		if (allErrors.length > 0) {
			const agg = new ServiceVerificationAggregateError(allErrors)
			this._errorsCache = agg
			this._lastBuildOk = false
			this._dependentsCache = new Map()
			this._aliasIndexCache = alias.aliasIndex
			this._dirty = false
			this._dirtyIds.clear()
			this._forceFullRebuild = false
			return createErr(agg)
		}

		this._errorsCache = undefined
		this._lastBuildOk = true

		if (incremental && prevDependents && prevServices && prevAliasIndex) {
			this._dependentsCache = applyDependentsDelta(
				prevDependents,
				prevServices,
				prevAliasIndex,
				services,
				alias.aliasIndex,
				incremental.affected,
			)
		} else {
			this._dependentsCache = dependentsMap
		}

		this._dirty = false
		this._dirtyIds.clear()
		this._forceFullRebuild = false
		return createOk({
			services: built.services,
			dependents: this._dependentsCache,
			aliasIndex: alias.aliasIndex,
		})
	}

	/** 基于校验结果构建容器 + 别名索引 */
	public build({
		autowire = true,
		aliasPolicy = 'error',
	}: BuildOptions = {}): Result<
		DiodContainer,
		ServiceVerificationAggregateError
	> {
		const r = this.buildServices({ autowire, aliasPolicy })
		if (!isOk(r)) return r
		const { services, dependents, aliasIndex } = r.val

		const container = new DiodContainer(
			services,
			dependents,
			this.builderSingletons,
			aliasIndex as unknown as ReadonlyMap<AliasKey, Identifier<unknown>>,
		)
		return createOk(container)
	}
}
