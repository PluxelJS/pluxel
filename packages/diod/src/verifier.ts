// verifier.ts

import { createErr, createOk, type Result } from 'option-t/plain_result'
import type { ServiceListMetadata } from './internal-types'
import type { AliasKey, Identifier } from './types'
import { RegistrationType } from './types'
import { getDependencyCount } from './utils/reflection'

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

const idName = (id: Identifier<unknown> | AliasKey): string => {
	if (typeof id === 'string') return id
	if (typeof id === 'symbol') return id.description ?? '(symbol)'
	// Identifier/Abstract 在运行期都是 function
	if (typeof id === 'function') return id.name || '(anonymous)'
	return '(anonymous)'
}

const resolveDependencyToken = (
	services: ServiceListMetadata,
	aliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>,
	dep: Identifier<unknown>,
): Identifier<unknown> => {
	if (services.has(dep)) return dep
	return aliasIndex.get(dep as unknown as AliasKey) ?? dep
}

const collectExplicitDependencyErrors = (
	services: ServiceListMetadata,
	nodes: Iterable<Identifier<unknown>>,
	errors: VerificationError[],
): void => {
	for (const id of nodes) {
		const meta = services.get(id)
		if (!meta) continue
		if (meta.type !== RegistrationType.Class) continue
		if (meta.autowire !== false) continue

		const expected = getDependencyCount(meta.class)
		const actual = meta.dependencies.length
		if (expected > actual) {
			errors.push({
				kind: 'InsufficientExplicitDependencies',
				id,
				expected,
				actual,
			})
		}
	}
}

const validateGraph = (
	services: ServiceListMetadata,
	aliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>,
	getRoots: () => Iterable<Identifier<unknown>>,
	shouldRecurse: (id: Identifier<unknown>) => boolean,
): VerificationError[] => {
	const color = new Map<Identifier<unknown>, 0 | 1 | 2>() // 0:white 1:gray 2:black
	const stack: Identifier<unknown>[] = []
	const stackIndex = new Map<Identifier<unknown>, number>() // node -> index in stack
	const errors: VerificationError[] = []

	collectExplicitDependencyErrors(services, getRoots(), errors)

	const dfs = (node: Identifier<unknown>): void => {
		const c = color.get(node) ?? 0
		if (c === 2) return
		if (c === 1) {
			const idx = stackIndex.get(node) ?? -1
			const loop = idx >= 0 ? [...stack.slice(idx), node] : [...stack, node]
			errors.push({ kind: 'CircularDependency', chain: loop })
			return
		}

		color.set(node, 1)
		stackIndex.set(node, stack.length)
		stack.push(node)

		const meta = services.get(node)
		if (meta) {
			for (const dep of meta.dependencies) {
				const resolved = resolveDependencyToken(services, aliasIndex, dep)
				if (!services.has(resolved)) {
					errors.push({
						kind: 'MissingDependency',
						missing: dep,
						chain: [...stack, dep],
					})
					continue
				}
				if (shouldRecurse(resolved)) dfs(resolved)
			}
		}

		stack.pop()
		stackIndex.delete(node)
		color.set(node, 2)
	}

	for (const id of getRoots()) {
		if (!services.has(id)) continue
		if ((color.get(id) ?? 0) === 0) dfs(id)
	}

	return errors
}

/* ----------------------------------------------------------------------------
 * 构建期校验错误（Builder 验证用）
 * 统一用 kind 判别，保证类型收窄稳定
 * ------------------------------------------------------------------------- */
export type VerificationError =
	| {
			kind: 'MissingDependency'
			/** 从根到缺失点的链（尾元素为缺失的 Identifier） */
			chain: Identifier<unknown>[]
			/** 便于程序化处理 */
			missing: Identifier<unknown>
	  }
	| {
			kind: 'CircularDependency'
			/** 环上的回路（首尾相连的那段） */
			chain: Identifier<unknown>[]
	  }
	| {
			kind: 'AliasConflict'
			alias: AliasKey
			ids: Identifier<unknown>[]
	  }
	// 新增：注册构建期异常（Builder 捕获 build() 抛出的错误后转为该错误）
	| {
			kind: 'InvalidRegistration'
			id: Identifier<unknown>
			message: string
	  }
	// 新增：关闭 autowire，但显式依赖数不足（以 ctor 形参个数为期望）
	| {
			kind: 'InsufficientExplicitDependencies'
			id: Identifier<unknown>
			expected: number
			actual: number
	  }

/* ----------------------------------------------------------------------------
 * 仅用于友好输出的聚合错误
 * ------------------------------------------------------------------------- */
export class ServiceVerificationAggregateError extends Error {
	public readonly errors: VerificationError[]

	constructor(errors: VerificationError[]) {
		super('Service verification failed. See errors for details.')
		this.errors = errors
		Object.setPrototypeOf(this, ServiceVerificationAggregateError.prototype)
	}

	public format(): string {
		if (this.errors.length === 0) return 'No verification errors.'
		return this.errors
			.map((e) => {
				switch (e.kind) {
					case 'MissingDependency': {
						const chain = e.chain.map(idName).join(' -> ')
						return `[MissingDependency] ${idName(e.missing)} | chain: ${chain}`
					}
					case 'CircularDependency': {
						const chain = e.chain.map(idName).join(' -> ')
						return `[CircularDependency] ${chain}`
					}
					case 'AliasConflict': {
						const ids = e.ids.map(idName).join(', ')
						return `[AliasConflict] alias=${idName(e.alias)} | ids=[${ids}]`
					}
					case 'InvalidRegistration': {
						return `[InvalidRegistration] ${idName(e.id)} | ${e.message}`
					}
					case 'InsufficientExplicitDependencies': {
						return `[InsufficientExplicitDependencies] ${idName(e.id)} | expected=${e.expected} actual=${e.actual}`
					}
					default:
						return `[Unknown]`
				}
			})
			.join('\n')
	}

	public override toString(): string {
		return this.format()
	}
}

/* ----------------------------------------------------------------------------
 * 线性时间三色 DFS 校验
 * - 灰色再次命中 => 环；
 * - 依赖缺失 => MissingDependency；
 * - 每个节点至多进入一次；
 * - 使用 stackIndex O(1) 构造环链
 * - 额外：在 DFS 前做 “非 autowire 的显式依赖数” 一致性校验
 * ------------------------------------------------------------------------- */
export const validateAllServices = (
	services: ServiceListMetadata,
	aliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>,
): VerificationError[] => {
	return validateGraph(
		services,
		aliasIndex,
		() => services.keys(),
		() => true,
	)
}

/* ----------------------------------------------------------------------------
 * 增量：仅校验子集（用于“变更很小”的 build）
 * 说明：
 * - 只从 subset 中的节点发起 DFS；
 * - DFS 只深入到 subset 内节点（subset 外视为“已验证的叶子”）；
 * - MissingDependency 仍按真实 services/aliasIndex 判断；
 * - 若你的变更可能影响 subset 之外的解析（如 aliasPolicy 非 error / 大范围别名重映射），
 *   应回退到 validateAllServices 进行全量校验。
 * ------------------------------------------------------------------------- */
export const validateServicesSubset = (
	services: ServiceListMetadata,
	aliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>,
	subset: ReadonlySet<Identifier<unknown>>,
): VerificationError[] => {
	if (subset.size === 0) return []
	return validateGraph(
		services,
		aliasIndex,
		() => subset,
		(id) => subset.has(id),
	)
}

/* ----------------------------------------------------------------------------
 * 反向依赖图：被依赖者 -> 依赖它的集合
 * 修复了 `??` + `if(!set)` 的逻辑陷阱
 * ------------------------------------------------------------------------- */
const computeDependents = (
	services: ServiceListMetadata,
	aliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>,
): Map<Identifier<unknown>, Set<Identifier<unknown>>> => {
	const dependentsMap = new Map<Identifier<unknown>, Set<Identifier<unknown>>>()
	for (const [service, metadata] of services) {
		for (const dep of metadata.dependencies) {
			const resolved = resolveDependencyToken(services, aliasIndex, dep)
			let set = dependentsMap.get(resolved)
			if (!set) {
				set = new Set<Identifier<unknown>>()
				dependentsMap.set(resolved, set)
			}
			set.add(service)
		}
	}
	return dependentsMap
}

/* ----------------------------------------------------------------------------
 * 校验并返回反向依赖图 + 全量错误（不抛异常）
 * 会从 “有效子图” 计算 dependents：
 *   - 出现在带 chain 的错误里的节点会被排除（环/缺失依赖）
 *   - 以及显式依赖数不足（InsufficientExplicitDependencies）的节点
 *   - InvalidRegistration 的节点通常不在 services map（构建失败未纳入），无需显式剔除
 * ------------------------------------------------------------------------- */
export const verifyAndComputeDependents = (
	services: ServiceListMetadata,
	aliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>,
): {
	dependentsMap: Map<Identifier<unknown>, Set<Identifier<unknown>>>
	errors: VerificationError[]
} => {
	const errors = validateAllServices(services, aliasIndex)

	// 聚合“问题节点”
	const problematic = new Set<Identifier<unknown>>()
	for (const e of errors) {
		if ('chain' in e) {
			for (const n of e.chain) problematic.add(n)
		} else if (e.kind === 'InsufficientExplicitDependencies') {
			problematic.add(e.id)
		}
		// InvalidRegistration is handled earlier
	}

	const validServices: ServiceListMetadata = new Map(
		[...services].filter(([id]) => !problematic.has(id)),
	)

	return { dependentsMap: computeDependents(validServices, aliasIndex), errors }
}

/* ----------------------------------------------------------------------------
 * 便捷：Result 形式（Err 包装为聚合错误，便于上层一把打印）
 * ------------------------------------------------------------------------- */
export const verifyAsResult = (
	services: ServiceListMetadata,
	aliasIndex: ReadonlyMap<AliasKey, Identifier<unknown>>,
): Result<
	Map<Identifier<unknown>, Set<Identifier<unknown>>>,
	ServiceVerificationAggregateError
> => {
	const { dependentsMap, errors } = verifyAndComputeDependents(services, aliasIndex)
	if (errors.length > 0) return createErr(new ServiceVerificationAggregateError(errors))
	return createOk(dependentsMap)
}
