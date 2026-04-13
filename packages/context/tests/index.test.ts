// tests/context.spec.ts
import { describe, expect, test } from 'vitest'
import { Context, type ServiceClass } from '@pluxel/context'

type TestServiceCtor = new (ctx: unknown, cfg?: unknown) => object
type TestServiceClass = ServiceClass<TestServiceCtor>
const asTestServiceClass = (ctor: unknown) => ctor as TestServiceClass

/* -------------------------------------------------------------------------- */
/* 1) 在测试文件里直接“声明合并 + 定义 Ctor + 注册”一条龙                     */
/* -------------------------------------------------------------------------- */

/** —— 声明合并：给 Context 增补类型（Config + 实例字段 + 代理方法） —— */
declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			/** 为 mathService 提供的配置（可选） */
			mathService?: { foo: string }
		}
		interface Services {
			mathService: MathService
			tapService: TapService
			countService: CountService
		}
		interface RootServices {
			rootTapService: RootTapService
		}
	}
	interface Context {
		/** 代理方法：自动转发到实例 */
		add(a: number, b: number): number
	}
}

/** —— 测试用服务 Ctor（与 Context 实现契合：new(ctx,cfg)） —— */
class MathService {
	static key = 'mathService' as const
	static methods = ['add'] as const

	constructor(
		public ctx: Context,
		private cfg: Context.Config['mathService'] | undefined,
	) {}

	add(a: number, b: number) {
		return a + b
	}
	getConfig() {
		return this.cfg
	}
}

/** —— 注册：生成 Context.prototype 的 getter 与方法代理 —— */
Context.registerService(asTestServiceClass(MathService))

/* -------------------------------------------------------------------------- */
/* 2) 额外服务：用于隔离/共享/冲突路径验证                                     */
/* -------------------------------------------------------------------------- */

class TapService {
	static key = 'tapService' as const
	static methods = ['ping'] as const
	constructedAt = Date.now()
	visits: string[] = []
	constructor(
		public ctx: Context,
		_cfg?: unknown,
	) {}
	ping() {
		this.visits.push(this.ctx.name ?? '')
		return this.ctx.name
	}
}
Context.registerService(asTestServiceClass(TapService))

class CountService {
	static key = 'countService' as const
	static methods = ['inc', 'get'] as const
	private n = 0
	constructor(
		public ctx: Context,
		_cfg?: unknown,
	) {}
	inc() {
		this.n += 1
	}
	get() {
		return this.n
	}
}
Context.registerService(asTestServiceClass(CountService))

class RootTapService {
	static key = 'rootTapService' as const
	static scope = 'root' as const
	constructor(
		public ctx: Context,
		_cfg?: unknown,
	) {}
	ping() {
		return this.ctx.name
	}
}
Context.registerService(asTestServiceClass(RootTapService))

/* -------------------------------------------------------------------------- */
/* 3) 覆盖用的新实现们（链式覆盖、last-wins）                                  */
/* -------------------------------------------------------------------------- */

class NewMathService {
	static key = 'mathService' as const
	static methods = ['add'] as const
	constructor(
		public ctx: Context,
		_cfg: Context.Config['mathService'] | undefined,
	) {}
	add(a: number, b: number) {
		return a * b
	}
}

class NewestMathService {
	static key = 'mathService' as const
	static methods = ['add'] as const
	constructor(
		public ctx: Context,
		_cfg: Context.Config['mathService'] | undefined,
	) {}
	add(a: number, b: number) {
		return a ** b
	}
}

/* -------------------------------------------------------------------------- */
/* 4) 测试                                                                   */
/* -------------------------------------------------------------------------- */

describe('基础行为：注入、代理、配置', () => {
	test('惰性注入与方法可用', () => {
		const ctx = new Context({ mathService: { foo: 'bar' } })
		const math = ctx.mathService
		expect(math).toBeInstanceOf(MathService)
		expect(math.add(2, 3)).toBe(5)
		expect(math.getConfig()).toEqual({ foo: 'bar' })
	})

	test('Context.prototype 的 add 代理到 MathService.add', () => {
		const ctx = new Context()
		expect(ctx.add(4, 5)).toBe(9)
	})
})

describe('extend / isolate / ctx 回灌', () => {
	test('extend 共享实例池：同一服务返回同一实例', () => {
		const ctx = new Context()
		const inst1 = ctx.mathService
		const child = ctx.extend()
		const inst2 = child.mathService
		expect(inst1).toBe(inst2)
	})

	test('isolate 为指定服务创建独立实例', () => {
		const ctx = new Context()
		const inst1 = ctx.mathService
		const iso = ctx.isolate([MathService])
		const inst2 = iso.mathService
		expect(inst2).toBeInstanceOf(MathService)
		expect(inst2).not.toBe(inst1)
		expect(iso.mathService).toBe(inst2)
	})

	test('isolate 隔离空间应对 extend 后代生效', () => {
		const ctx = new Context()
		const rootInst = ctx.mathService

		const iso = ctx.isolate([MathService], { name: 'iso' })
		const isoInst = iso.mathService
		expect(isoInst).not.toBe(rootInst)

		const isoChild = iso.extend({ name: 'iso.child' })
		expect(isoChild.mathService).toBe(isoInst)
		expect(isoChild.mathService).not.toBe(rootInst)
	})

	test('共享实例 + ctx 回灌：同一实例在不同上下文访问时 ctx 指针会变', () => {
		const ctx = new Context({ name: 'root' })
		const child = ctx.extend({ name: 'child-1' })
		const child2 = ctx.extend({ name: 'child-2' })

		const inst = ctx.tapService as InstanceType<typeof TapService>
		expect(inst.ping()).toBe('root')
		expect(child.tapService).toBe(inst)
		expect(inst.ping()).toBe('child-1')
		expect(child2.tapService).toBe(inst)
		expect(inst.ping()).toBe('child-2')
		expect(inst.visits).toEqual(['root', 'child-1', 'child-2'])
	})

	test('root scope：同一实例永远绑定 root ctx', () => {
		const ctx = new Context({ name: 'root' })
		const child = ctx.extend({ name: 'child' })
		const inst = ctx.root.rootTapService as unknown as RootTapService
		expect(inst.ping()).toBe('root')
		expect(child.root.rootTapService).toBe(inst)
		expect(inst.ctx.name).toBe('root')
		expect(child.root.rootTapService.ping()).toBe('root')
	})

	test('isolate 不允许隔离 root scope 服务（避免误导：root 服务总是走 ctx.root）', () => {
		const ctx = new Context({ name: 'root' })
		// isolateKeys is type-safe and excludes RootServices, so this uses a cast to reach the runtime guard.
		expect(() =>
			ctx.isolateKeys(['rootTapService'] as unknown as Iterable<keyof Context.PublicServices>),
		).toThrow()
		expect(() => ctx.isolate([asTestServiceClass(RootTapService)])).toThrow()
	})

	test('config 合并（构造注入快照不变）', () => {
		const ctx = new Context({ name: 'root', mathService: { foo: 'A' } })
		const rootMath = ctx.mathService
		expect(rootMath.getConfig()).toEqual({ foo: 'A' })

		const child = ctx.extend({ config: { mathService: { foo: 'B' } }, name: 'child' })
		expect(child.mathService).toBe(rootMath)
		expect(child.mathService.getConfig()).toEqual({ foo: 'A' })
	})

	test('isolate 后按子上下文 config 构造', () => {
		const ctx = new Context({ name: 'root', mathService: { foo: 'A' } })
		const iso = ctx.isolate([MathService], { config: { mathService: { foo: 'B' } }, name: 'iso' })
		expect(iso.mathService.getConfig()).toEqual({ foo: 'B' })
	})
})

describe('覆盖（override）：单次与链式、代理同步', () => {
	test('单次覆盖：实例类型与代理更新', () => {
		Context.overrideService(asTestServiceClass(MathService), asTestServiceClass(NewMathService))
		const ctx = new Context()
		const inst = ctx.mathService
		expect(inst).toBeInstanceOf(NewMathService)
		expect(ctx.add(3, 4)).toBe(12)
	})

	test('链式覆盖：后者生效（last-wins），代理亦更新', () => {
		Context.overrideService(
			asTestServiceClass(NewMathService),
			asTestServiceClass(NewestMathService),
		)
		const ctx = new Context()
		const inst = ctx.mathService
		expect(inst).toBeInstanceOf(NewestMathService)
		expect(ctx.add(2, 3)).toBe(8) // 2 ** 3
	})

	test('覆盖后的 isolate：仍指向覆盖类型，且实例隔离', () => {
		const ctx = new Context()
		const rootInst = ctx.mathService
		expect(rootInst).toBeInstanceOf(NewestMathService)

		const iso = ctx.isolate([MathService])
		const isoInst = iso.mathService
		expect(isoInst).toBeInstanceOf(NewestMathService)
		expect(isoInst).not.toBe(rootInst)
		expect(iso.add(2, 3)).toBe(8)

		const iso2 = ctx.isolate([asTestServiceClass(NewestMathService)])
		const isoInst2 = iso2.mathService
		expect(isoInst2).toBeInstanceOf(NewestMathService)
		expect(isoInst2).not.toBe(rootInst)
		expect(iso2.add(2, 3)).toBe(8)
	})
})

describe('错误/冲突路径', () => {
	test('重复注册同 key 抛错', () => {
		class Dup1 {
			static key = 'dup' as const
			constructor(
				public ctx: Context,
				_cfg?: unknown,
			) {}
		}
		class Dup2 {
			static key = 'dup' as const
			constructor(
				public ctx: Context,
				_cfg?: unknown,
			) {}
		}
		Context.registerService(asTestServiceClass(Dup1))
		expect(() => Context.registerService(asTestServiceClass(Dup2))).toThrow()
	})

	test('methods 与 Context.prototype 冲突不应覆盖', () => {
		class ShadowSvc {
			static key = 'shadowService' as const
			static methods = ['extend'] as const
			constructor(
				public ctx: Context,
				_cfg?: unknown,
			) {}
			extend() {
				return 'should_not_override'
			}
		}
		Context.registerService(asTestServiceClass(ShadowSvc))
		const ctx = new Context()
		const child = ctx.extend({ name: 'ok' })
		expect(child.name).toBe('ok') // 仍是 Context 的 extend
		expect((ctx as unknown as { shadowService: ShadowSvc }).shadowService.extend()).toBe(
			'should_not_override',
		)
	})

	test('overrideService 不应覆盖 Context.prototype 原生方法', () => {
		class ShadowOriginal {
			static key = 'overrideShadowService' as const
			constructor(
				public ctx: Context,
				_cfg?: unknown,
			) {}
		}
		class ShadowOverride {
			static methods = ['extend'] as const
			constructor(
				public ctx: Context,
				_cfg?: unknown,
			) {}
			extend() {
				return 'should_not_override'
			}
		}
		Context.registerService(asTestServiceClass(ShadowOriginal))
		Context.overrideService(asTestServiceClass(ShadowOriginal), asTestServiceClass(ShadowOverride))

		const ctx = new Context()
		const child = ctx.extend({ name: 'ok' })
		expect(child.name).toBe('ok')
	})

	test('未注册服务覆盖应抛错', () => {
		class NotRegistered {
			static key = 'notRegisteredService' as const
			constructor(
				public ctx: Context,
				_cfg?: unknown,
			) {}
		}
		class X {
			constructor(
				public ctx: Context,
				_cfg?: unknown,
			) {}
		}
		expect(() =>
			Context.overrideService(asTestServiceClass(NotRegistered), asTestServiceClass(X)),
		).toThrow()
	})

	test('isolate 未注册服务应抛错（避免隐式污染映射）', () => {
		class NotRegisteredService {
			static key = 'notRegisteredService' as const
			constructor(
				public ctx: Context,
				_cfg?: unknown,
			) {}
		}
		const ctx = new Context()
		expect(() => ctx.isolate([asTestServiceClass(NotRegisteredService)])).toThrow()
	})
})

describe('多服务隔离/共享混用', () => {
	test('仅隔离名单内；其余共享', () => {
		const ctx = new Context()
		const iso = ctx.isolate([MathService])
		expect(iso.mathService).not.toBe(ctx.mathService) // 隔离
		expect(iso.countService).toBe(ctx.countService) // 共享
		ctx.countService.inc()
		expect(iso.countService.get()).toBe(1)
	})

	test('重复列出隔离目标无副作用', () => {
		const ctx = new Context()
		const iso = ctx.isolate([asTestServiceClass(MathService), asTestServiceClass(MathService)])
		expect(iso.mathService).not.toBe(ctx.mathService)
	})
})
