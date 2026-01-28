import '@pluxel/core/test/setup'

import { describe, expect, it } from 'bun:test'
import {
	BasePlugin,
	Context,
	ForkablePlugin,
	type ForkablePluginConstructor,
	Plugin,
	setParamToken,
} from '@pluxel/core'
import { LoaderService } from '../../src/services/loader/LoaderService'
import { EXTRA_FORKS, type ForksExtra } from '../../src/services/loader/selection'

function createHmrCtx(core: Context) {
	const enabled = new Set<string>()
	const extra: Record<string, unknown> = Object.create(null)
	const configService = {
		isReady: true,
		ready: Promise.resolve(),
		isEnabledInConfig(name: string) {
			return enabled.has(name)
		},
		setEnabledInConfig(name: string, on: boolean) {
			if (on) enabled.add(name)
			else enabled.delete(name)
		},
		enableInConfig(...names: string[]) {
			for (const n of names) enabled.add(n)
		},
		disableInConfig(...names: string[]) {
			for (const n of names) enabled.delete(n)
		},
		getRawConfig(_name: string) {
			return {}
		},
		getConfigRevision() {
			return 0
		},
		ensureValidated() {
			return Promise.resolve({})
		},
		patchConfig: () => undefined,
		getExtra(key: string) {
			return extra[key]
		},
		setExtra(key: string, value: unknown) {
			extra[key] = value
		},
		batch(run: () => void) {
			run()
		},
	}

	// Context from @pluxel/core exposes many services as readonly getters.
	// For loader/HMR unit tests we provide a minimal shim context that delegates
	// event wiring to the real core context but keeps stubs writable.
	const coreAny = core as unknown as { events?: unknown; emit?: unknown }
	return {
		registry: core.registry,
		events: coreAny.events,
		on: core.on.bind(core),
		emit:
			typeof coreAny.emit === 'function'
				? (coreAny.emit as (...args: unknown[]) => unknown).bind(core)
				: undefined,
		logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		configService,
	} as unknown as Context
}

describe('LoaderService', () => {
	it('preloadPlugins supports forkable builtins (including enabled forks)', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Forky' })
		class Forky extends ForkablePlugin {}

		await loader.preloadPlugins([
			{
				plugin: Forky,
				enable: false,
				forks: ['a', { id: 'b', enable: true }, { id: 'c', enable: false }],
			},
		])

		expect(ctx.configService.isEnabledInConfig('Forky')).toBe(false)
		expect(ctx.configService.isEnabledInConfig('Forky#a')).toBe(true)
		expect(ctx.configService.isEnabledInConfig('Forky#b')).toBe(true)
		expect(ctx.configService.isEnabledInConfig('Forky#c')).toBe(false)

		const catalog = ctx.configService.getExtra(EXTRA_FORKS) as ForksExtra | undefined
		expect(catalog?.Forky?.slice().sort()).toEqual(['a', 'b', 'c'])

		const ForkA = core.registry.fork(Forky as unknown as ForkablePluginConstructor, 'a')
		const ForkB = core.registry.fork(Forky as unknown as ForkablePluginConstructor, 'b')
		expect(core.registry.isRunning(Forky)).toBe(false)
		expect(core.registry.isRunning(ForkA)).toBe(true)
		expect(core.registry.isRunning(ForkB)).toBe(true)

		// Fork source should resolve to the base plugin module id.
		expect(loader.api.registry.findModuleId('Forky#a')).toBe('pluxel:builtins')
	})

	it('preloadPlugins enables and commits builtins', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Builtin' })
		class Builtin extends BasePlugin {}

		const names = await loader.preloadPlugins([Builtin])
		expect(names).toEqual(['Builtin'])
		expect(ctx.configService.isEnabledInConfig('Builtin')).toBe(true)
		expect(loader.api.registry.getCtor('Builtin')).toBe(Builtin)
		expect(loader.api.registry.findModuleId('Builtin')).toBe('pluxel:builtins')
		expect(core.registry.isRunning(Builtin)).toBe(true)
	})

	it('preloaded builtin baseline survives later failed batch rollback', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Builtin' })
		class Builtin extends BasePlugin {}

		await loader.preloadPlugins([Builtin])
		expect(core.registry.isRunning(Builtin)).toBe(true)

		abstract class MissingBase extends BasePlugin {}

		@Plugin({ name: 'Bad' })
		class Bad extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		setParamToken(Bad, 0, MissingBase)

		ctx.configService.enableInConfig('Bad')
		{
			const batch = loader.beginBatch()
			await batch.replaceModule('Bad.ts', { Bad })
			const res = await core.registry.commit()
			expect(res.ok).toBe(false)
			batch.rollback()
			core.registry.resetDraft()
		}

		expect(core.registry.isRunning(Builtin)).toBe(true)
		expect(loader.api.registry.getCtor('Builtin')).toBe(Builtin)
	})

	it('dependency inspector tolerates abstract/base tokens', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const loader = new LoaderService(ctx)

		abstract class Abs extends BasePlugin {}

		@Plugin(Abs, { name: 'Impl' })
		class Impl extends Abs {}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(_dep: Abs) {
				super()
			}
		}
		setParamToken(Consumer, 0, Abs)

		core.registry.register(Impl)
		core.registry.register(Consumer)
		const res = await core.registry.commit()
		expect(res.ok).toBe(true)

		const deps = loader.api.deps.list(Consumer)
		expect(deps).toEqual([{ name: 'Abs', isRunning: true }])
	})

	it('batch rollback keeps loader state consistent when core commit fails', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		// Enable baseline provider; the later consumer will be enabled too.
		ctx.configService.enableInConfig('Impl1', 'Consumer')
		const loader = new LoaderService(ctx)

		abstract class Abs extends BasePlugin {}
		abstract class MissingBase extends BasePlugin {}

		@Plugin(Abs, { name: 'Impl1' })
		class Impl1 extends Abs {}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(_dep: MissingBase) {
				super()
			}
		}
		setParamToken(Consumer, 0, MissingBase)

		// Baseline: load module A providing Impl1 and commit successfully.
		{
			const batch = loader.beginBatch()
			await batch.replaceModule('A.ts', { Impl1 })
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		expect(core.registry.isRunning(Abs)).toBe(true)
		expect(core.registry.getInstance(Abs)).toBeInstanceOf(Impl1)

		// Hot update: load module B providing an enabled plugin with missing deps -> commit should fail.
		{
			const batch = loader.beginBatch()
			await batch.replaceModule('B.ts', { Consumer })
			const res = await core.registry.commit()
			expect(res.ok).toBe(false)
			batch.rollback()
			core.registry.resetDraft()
		}

		// After rollback, loader should not claim Consumer is loaded.
		expect(loader.api.registry.getCtor('Consumer')).toBeUndefined()
		expect(loader.api.anchors.has('B.ts')).toBe(false)

		// Core should still be on the previous container: base resolves to Impl1 and remains running.
		expect(core.registry.isRunning(Abs)).toBe(true)
		expect(core.registry.getInstance(Abs)).toBeInstanceOf(Impl1)
	})

	it('replaceModule normalizes ctor-param tokens by plugin id (builtin/HMR ctor identity mismatch)', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const warns: unknown[] = []
		;(ctx as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger.warn = (
			...args: unknown[]
		) => warns.push(args)
		ctx.configService.enableInConfig('Dep', 'Consumer')
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Dep' })
		class Dep extends BasePlugin {}

		// 模拟 HMR 插件模块里“拿到了另一个 ctor 引用”，但插件 id 相同。
		// 真实场景常见于：builtin 预载已注册/运行，而 HMR 模块因为不同入口/打包产物/热更新重复评估
		// 导致导入到一个“同 id 的 ctor”，如果不归一化就会 MissingDependency。
		@Plugin({ name: 'Dep' })
		class DepShadow extends BasePlugin {}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(_dep: DepShadow) {
				super()
			}
		}
		setParamToken(Consumer, 0, DepShadow)

		await loader.preloadPlugins([Dep])
		expect(core.registry.isRunning(Dep)).toBe(true)

		{
			const batch = loader.beginBatch()
			await batch.replaceModule('Consumer.ts', { Consumer })
			const res = await core.registry.commit()
			expect(res.ok).toBe(true)
			batch.commit()
		}

		expect(core.registry.isRunning(Consumer)).toBe(true)
		expect(warns.length).toBe(1)
		expect((warns[0] as unknown[])[0]).toBe(
			'依赖注入 token 已归一化：检测到同 id 不同 ctor 引用（建议检查 bridge/导入路径）',
		)
		expect((warns[0] as unknown[])[1]).toMatchObject({
			moduleId: 'Consumer.ts',
			consumer: 'Consumer',
		})
	})

	it('registry view exposes module ids and loaded names', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Alpha' })
		class Alpha extends BasePlugin {}

		@Plugin({ name: 'Beta' })
		class Beta extends BasePlugin {}

		const batch = loader.beginBatch()
		await batch.replaceModule('B.ts', { Beta })
		await batch.replaceModule('A.ts', { Alpha })
		const res = await core.registry.commit()
		expect(res.ok).toBe(true)
		batch.commit()

		expect(loader.api.registry.findModuleId('Alpha')).toBe('A.ts')
		expect(loader.api.registry.findModuleIdByName('Beta')).toBe('B.ts')
		expect(loader.api.registry.listLoadedNames()).toEqual(['Alpha', 'Beta'])
	})

	it('anchors remove expects clean ids', async () => {
		const core = new Context()
		const ctx = createHmrCtx(core)
		const loader = new LoaderService(ctx)

		@Plugin({ name: 'Anchor' })
		class Anchor extends BasePlugin {}

		const batch = loader.beginBatch()
		await batch.replaceModule('/abs/Plugin.ts', { Anchor })

		expect(loader.api.anchors.has('/abs/Plugin.ts')).toBe(true)
		loader.api.anchors.remove('/abs/Plugin.ts')
		expect(loader.api.anchors.has('/abs/Plugin.ts')).toBe(false)
	})
})
