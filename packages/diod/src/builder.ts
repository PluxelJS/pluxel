// builder.ts
// Goals:
// - Result-first core (no throw inside hot path)
// - Thin throwing wrappers for fluent DX (register().use())
// - Single dirty flag; simple, predictable invalidation
// - Rebuild alias index on each build from fresh services metadata
// - Idempotent unregister()

import { createErr, createOk, isOk, type Result } from 'option-t/plain_result'
import { DiodContainer } from './container'
import type {
	Buildable,
	ServiceData,
	ServiceListMetadata,
} from './internal-types'
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
	protected readonly buildables: IBuildable = new Map()

	/** 构建期与惰性创建的 Builder_Singleton 实例缓存 */
	public builderSingletons: Map<Identifier<unknown>, unknown> = new Map()

	/* ---------------------------- simple cache line --------------------------- */
	private _dirty = true
	private _lastAutowire: boolean | undefined
	private _servicesCache?: Map<Identifier<unknown>, ServiceData<unknown>>
	private _dependentsCache?: Map<Identifier<unknown>, Set<Identifier<unknown>>>
	private _errorsCache?: ServiceVerificationAggregateError
	private _frozen = false

	private markDirty(): void {
		this._dirty = true
		this._servicesCache = undefined
		this._dependentsCache = undefined
		this._errorsCache = undefined
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
		const buildable = DiodRegistration.createBuildable(identifier, () => {
			this.markDirty() // any config change → dirty
		})
		this.buildables.set(identifier, buildable)
		this.markDirty()
		return createOk(buildable.instance as Registration<T>)
	}

	private _tryUnregisterCore<T>(
		identifier: Identifier<T>,
	): Result<boolean, RegistryError> {
		if (this._frozen) return createErr({ kind: 'Frozen' })
		const existed = this.buildables.delete(identifier)
		this.builderSingletons.delete(identifier)
		if (existed) this.markDirty()
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

	public buildServices({
		autowire = true,
	}: {
		autowire?: boolean
	} = {}): Result<
		{
			services: ServiceMap
			dependents: Map<Identifier<unknown>, Set<Identifier<unknown>>>
		},
		ServiceVerificationAggregateError
	> {
		if (
			!this._dirty &&
			this._servicesCache &&
			this._lastAutowire === autowire
		) {
			if (this._errorsCache) return createErr(this._errorsCache)
			return createOk({
				services: this._servicesCache,
				dependents: this._dependentsCache ?? new Map(),
			})
		}

		const built = this.buildMetadataMap(autowire)
		this._servicesCache = built.services
		this._lastAutowire = autowire

		const { dependentsMap, errors } = verifyAndComputeDependents(
			built.services as ServiceListMetadata,
		)
		const allErrors = built.errors.length
			? [...built.errors, ...errors]
			: errors

		if (allErrors.length > 0) {
			const agg = new ServiceVerificationAggregateError(allErrors)
			this._errorsCache = agg
			this._dependentsCache = new Map()
			this._dirty = false
			return createErr(agg)
		}

		this._errorsCache = undefined
		this._dependentsCache = dependentsMap
		this._dirty = false
		return createOk({ services: built.services, dependents: dependentsMap })
	}

	/** 基于校验结果构建容器 + 别名索引 */
	public build({
		autowire = true,
		aliasPolicy = 'error',
	}: BuildOptions = {}): Result<
		DiodContainer,
		ServiceVerificationAggregateError
	> {
		const r = this.buildServices({ autowire })
		if (!isOk(r)) return r
		const { services, dependents } = r.val

		// 直接从最新 services 计算别名索引（小规模时成本很低，且最可靠）
		const aliasIndex = new Map<AliasKey, Identifier<unknown>>()
		if (aliasPolicy === 'firstWins' || aliasPolicy === 'lastWins') {
			for (const [id, meta] of services) {
				const aliases = meta.aliases as readonly AliasKey[] | undefined
				if (!aliases) continue
				if (aliasPolicy === 'firstWins') {
					for (let i = 0; i < aliases.length; i++) {
						const a = aliases[i]!
						if (!aliasIndex.has(a)) aliasIndex.set(a, id)
					}
				} else {
					// lastWins
					for (let i = 0; i < aliases.length; i++) {
						aliasIndex.set(aliases[i]!, id)
					}
				}
			}
		} else {
			// aliasPolicy === 'error'
			const seen = new Map<AliasKey, Identifier<unknown>>()
			const conflicts: { alias: AliasKey; ids: Identifier<unknown>[] }[] = []
			for (const [id, meta] of services) {
				const aliases = meta.aliases as readonly AliasKey[] | undefined
				if (!aliases) continue
				for (let i = 0; i < aliases.length; i++) {
					const a = aliases[i]!
					const prev = seen.get(a)
					if (prev === undefined) {
						seen.set(a, id)
					} else if (prev !== id) {
						const bucket = conflicts.find((x) => x.alias === a)
						if (bucket) bucket.ids.push(id)
						else conflicts.push({ alias: a, ids: [prev, id] })
					}
				}
			}
			if (conflicts.length) {
				const errors = conflicts.map((c) => ({
					kind: 'AliasConflict' as const,
					alias: c.alias,
					ids: c.ids,
				}))
				return createErr(new ServiceVerificationAggregateError(errors))
			}
			// 无冲突：seen 即索引
			for (const [a, id] of seen) aliasIndex.set(a, id)
		}

		const container = new DiodContainer(
			services,
			dependents,
			this.builderSingletons,
			aliasIndex,
		)
		return createOk(container)
	}

	/* ------------------------------- Internals -------------------------------- */

	private buildMetadataMap(autowire: boolean): {
		services: Map<Identifier<unknown>, ServiceData<unknown>>
		errors: VerificationError[]
	} {
		const services = new Map<Identifier<unknown>, ServiceData<unknown>>()
		let errors: VerificationError[] | undefined

		for (const [identifier, buildable] of this.buildables) {
			try {
				const data = buildable.build({ autowire })
				const deps = data.dependencies
				if (Array.isArray(deps)) Object.freeze(deps)
				services.set(identifier, data)
			} catch (e) {
				if (!errors) errors = []
				errors.push({
					kind: 'InvalidRegistration',
					id: identifier,
					message: e instanceof Error ? e.message : String(e),
				})
			}
		}
		return { services, errors: errors ?? [] }
	}
}
