// builder.ts
import { DiodContainer } from './container'
import { DiodRegistration } from './registration'
import type {
	BuildOptions,
	Identifier,
	Newable,
	Registration,
	ConfigurableRegistration,
	WithDependencies,
	WithScopeChange,
	AliasKey,
	AliasConflictPolicy,
} from './types'
import type {
	Buildable,
	ServiceData,
	ServiceListMetadata,
} from './internal-types'
import {
	verifyAndComputeDependents,
	ServiceVerificationAggregateError,
	type VerificationError,
} from './verifier'
import { type Result, createOk, createErr, isOk } from 'option-t/plain_result'

/* --------------------------------- Types ---------------------------------- */

type BuildableKV<T = unknown> = [Identifier<T>, Buildable<Registration<T>, T>]
type IBuildable = Map<BuildableKV[0], BuildableKV[1]>
type ServiceMap<T = unknown> = ReadonlyMap<Identifier<T>, ServiceData<T>>

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

	/* ---------------------------- light-weight cache --------------------------- */
	private _dirty = true
	private _lastAutowire: boolean | undefined
	private _servicesCache?: Map<Identifier<unknown>, ServiceData<unknown>>
	private _dependentsCache?: Map<Identifier<unknown>, Set<Identifier<unknown>>>
	private _errorsCache?: ServiceVerificationAggregateError

	private markDirty(): void {
		this._dirty = true
		this._servicesCache = undefined
		this._dependentsCache = undefined
		this._errorsCache = undefined
	}

	/* -------------------------------- Registry -------------------------------- */

	public register<T>(
		identifier: Identifier<T>,
	): Result<Registration<T>, RegistryError> {
		if (this.buildables.has(identifier)) {
			return createErr({ kind: 'AlreadyRegistered', id: identifier })
		}
		const buildable = DiodRegistration.createBuildable(identifier)
		this.buildables.set(identifier, buildable)
		this.markDirty()
		return createOk(buildable.instance)
	}

	public unregister<T>(identifier: Identifier<T>): Result<void, RegistryError> {
		if (!this.buildables.has(identifier)) {
			return createErr({ kind: 'NotRegistered', id: identifier })
		}
		this.buildables.delete(identifier)
		this.builderSingletons.delete(identifier)
		this.markDirty()
		return createOk(undefined)
	}

	public isRegistered<T>(identifier: Identifier<T>): boolean {
		return this.buildables.has(identifier)
	}

	public registerAndUse<T>(
		newable: Newable<T>,
	): Result<
		ConfigurableRegistration & WithScopeChange & WithDependencies,
		RegistryError
	> {
		const r = this.register(newable)
		if (!isOk(r)) return r
		return createOk(r.val.use(newable))
	}

	public ensure<T>(identifier: Identifier<T>): Result<Registration<T>, never> {
		const existed = this.buildables.get(identifier)
		if (existed) return createOk(existed.instance as Registration<T>)
		const r = this.register(identifier)
		return isOk(r)
			? r
			: createOk(DiodRegistration.createBuildable(identifier).instance)
	}

	/* --------------------------- Build & Verification -------------------------- */

	public buildServices({
		autowire = true,
	}: { autowire?: boolean } = {}): Result<
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

	/** 构建不可变容器（含 alias 索引） */
	public build({
		autowire = true,
		aliasPolicy = 'error',
	}: BuildOptions = {}): Result<
		DiodContainer,
		ServiceVerificationAggregateError
	> {
		const r = this.buildServices({ autowire })
		if (!isOk(r)) return r as any
		const { services, dependents } = r.val

		// 构建 alias 索引
		const aliasIndex = new Map<AliasKey, Identifier<unknown>>()
		const conflicts: { alias: AliasKey; ids: Identifier<unknown>[] }[] = []

		for (const [id, meta] of services) {
			const aliases = meta.aliases
			if (!aliases || aliases.length === 0) continue
			for (let i = 0; i < aliases.length; i++) {
				const a = aliases[i]!
				const existed = aliasIndex.get(a)
				if (!existed) {
					aliasIndex.set(a, id)
				} else if (existed !== id) {
					if (aliasPolicy === 'error') {
						const bucket = conflicts.find((x) => x.alias === a)
						if (bucket) bucket.ids.push(id)
						else conflicts.push({ alias: a, ids: [existed, id] })
					} else if (aliasPolicy === 'lastWins') {
						aliasIndex.set(a, id)
					} // firstWins: 保留原值
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

		return createOk(
			new DiodContainer(
				services,
				dependents,
				this.builderSingletons,
				aliasIndex,
			),
		)
	}

	/* ------------------------------- Internals -------------------------------- */

	private buildMetadataMap(autowire: boolean): {
		services: Map<Identifier<unknown>, ServiceData<unknown>>
		errors: VerificationError[]
	} {
		const services = new Map<Identifier<unknown>, ServiceData<unknown>>()
		const errors: VerificationError[] = []

		for (const [identifier, buildable] of this.buildables) {
			try {
				const data = buildable.build({ autowire })
				if (Array.isArray(data.dependencies)) Object.freeze(data.dependencies)
				services.set(identifier, data)
			} catch (e) {
				errors.push({
					kind: 'InvalidRegistration',
					id: identifier,
					message: e instanceof Error ? e.message : String(e),
				})
				// 该服务构建失败，不放入 services，有效子图自然会排除它
			}
		}
		return { services, errors }
	}
}
