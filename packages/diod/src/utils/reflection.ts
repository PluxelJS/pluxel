// utils/reflection.ts
import type { Abstract } from '../types/types'

/** 设计时元数据 key */
const PARAM_TYPES = 'design:paramtypes'

type DepCacheEntry =
	| { kind: 'deps'; deps: readonly Abstract<unknown>[] }
	| { kind: 'missingDecoration' }

const depsCache = new WeakMap<Abstract<unknown>, DepCacheEntry>()
const ctorNoParamCache = new WeakMap<Abstract<unknown>, boolean>()

/** 特指“需要装饰但未装饰”的构建期错误，由 builder 捕获并转为 InvalidRegistration */
export class UndecoratedServiceError extends Error {
	public readonly chain: string[]
	public readonly targetName: string

	constructor(target: Abstract<unknown>, chain: string[]) {
		super(`Service not decorated: ${[...chain, target.name].join(' -> ')}`)
		this.chain = chain
		this.targetName = target.name
		Object.setPrototypeOf(this, UndecoratedServiceError.prototype)
	}
}

/** 从装饰元数据读取依赖；若应有而没有，则抛出 UndecoratedServiceError（由上层收敛） */
const getDependenciesFromDecoratedServiceOrThrow = <T>(
	target: Abstract<T>,
	parents: string[],
): Abstract<unknown>[] => {
	const cached = depsCache.get(target)
	if (cached) {
		if (cached.kind === 'deps') return cached.deps as Abstract<unknown>[]
		if (cached.kind === 'missingDecoration') {
			throw new UndecoratedServiceError(target, parents)
		}
	}

	// Reflect metadata 可能不存在；统一用空数组兜底
	const reflect = Reflect as unknown as {
		getMetadata?: (key: string, target: unknown) => unknown
	}
	const dependencies: Abstract<unknown>[] =
		(reflect.getMetadata?.(PARAM_TYPES, target) as
			| Abstract<unknown>[]
			| undefined) ?? []

	// 若 ctor 形参个数 > 已读依赖数，说明未启用 reflect-metadata / 未加装饰器
	if (dependencies.length < target.length) {
		depsCache.set(target, { kind: 'missingDecoration' })
		throw new UndecoratedServiceError(target, parents)
	}

	// 缓存（包含空数组），避免重复 Reflect.getMetadata + length 判断
	depsCache.set(target, {
		kind: 'deps',
		deps: Object.freeze([...dependencies]),
	})
	return dependencies
}

/** 获取直接基类（到 Object 为止） */
const getBaseClass = <T extends B, B>(
	target: Abstract<T>,
): Abstract<B> | undefined => {
	const baseClass = Object.getPrototypeOf(target.prototype)?.constructor
	if (baseClass === Object) return undefined
	return baseClass
}

/** 去注释（用于粗略判定是否显式声明了“无参构造”） */
function stripComments(code: string): string {
	const noLine = code.replace(/\/\/.*$/gm, '')
	return noLine.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * “是否定义了**自身**无参构造”。
 * 说明：我们不解析 AST，仅通过 toString + 正则粗判。
 */
const hasOwnConstructorWithoutParams = <T>(target: Abstract<T>): boolean => {
	const cached = ctorNoParamCache.get(target)
	if (cached !== undefined) return cached

	const proto = target.prototype as object
	const classString = stripComments(proto.constructor.toString())
	const constructorRegex = /\s*constructor\s*\(\s*\)\s*\{/
	const ok = constructorRegex.test(classString)
	ctorNoParamCache.set(target, ok)
	return ok
}

/**
 * 递归读取依赖（会沿着继承链向上找装饰）
 * 规则：
 * 1) 若装饰元数据存在，直接返回；
 * 2) 若自身声明了“无参构造”，返回 []；
 * 3) 否则沿基类继续查找；
 * 4) 若最终仍无法给出依赖，且 ctor 有参数，会抛 UndecoratedServiceError（由 builder 收敛）
 */
export const getDependencies = <T>(
	target: Abstract<T>,
	parents: string[] = [],
): Abstract<unknown>[] => {
	// 尝试从当前类读取元数据；失败会抛 UndecoratedServiceError
	const deps = getDependenciesFromDecoratedServiceOrThrow(target, parents)
	if (deps.length > 0) return deps

	// 明确声明了“无参构造”，则无依赖
	if (hasOwnConstructorWithoutParams(target)) return []

	// 否则交给基类；parents 仅用于报错链路展示
	const baseClass = getBaseClass(target)
	if (baseClass) {
		return getDependencies(baseClass, [...parents, target.name])
	}

	// 走到继承链顶且没有依赖信息：此时若 ctor 有参，本函数前面的读取已抛错；
	// 若 ctor 无参（包括隐式无参），即使没有装饰，也可以视为 []
	return []
}

/**
 * 估算 ctor 期望依赖数量（用于非 autowire 校验）
 * 逻辑：优先使用 target.length；若为 0，则沿基类继续。
 */
export const getDependencyCount = <T>(target: Abstract<T>): number => {
	if (target.length > 0) return target.length
	const baseClass = getBaseClass(target)
	if (baseClass) return getDependencyCount(baseClass)
	return 0
}
