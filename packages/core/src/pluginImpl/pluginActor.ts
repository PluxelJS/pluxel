// packages/core/src/pluginImpl/pluginActor.ts
import { setup, fromPromise, type ActorRefFrom } from 'xstate'
import type { Context as DI } from '@pluxel/context'
import type { BasePlugin } from './BasePlugin'

// ---------- 外部事件 ----------
export type LifecycleEvent =
	| { type: 'START' }
	| { type: 'STOP' }
	| { type: 'RELOAD'; patch?: unknown }
	| { type: 'RETRY' }

// ---------- 系统事件（用于 onError/onDone 的类型缩小） ----------
type SystemEvents =
	| { type: 'xstate.error.actor'; error: unknown }
	| { type: 'xstate.done.actor'; output?: unknown }

// ---------- 被调用 actor 的输入 ----------
type StartInput<P extends BasePlugin> = { plugin: P; pluginCtx: DI }
type StopInput<P extends BasePlugin> = { plugin: P }
type ReloadInput<P extends BasePlugin> = {
	plugin: P
	pluginCtx: DI
	patch?: unknown
}

// ---------- 机器输入 & 上下文 ----------
export interface LifecycleInput<
	Cfg = unknown,
	P extends BasePlugin = BasePlugin,
> {
	id: unknown
	plugin: P
	pluginCtx: DI
	config?: Cfg
}

type FailedStep = 'start' | 'reload' | 'stop' | undefined

interface LifecycleCtx<Cfg = unknown, P extends BasePlugin = BasePlugin>
	extends LifecycleInput<Cfg, P> {
	attempt: number // 连续失败次数（成功后清零）
	err?: unknown // 最近一次错误
	startedAt?: number // 首次成功启动时间戳
	failedStep: FailedStep // 失败发生在哪个阶段
}

export interface LifecycleOptions {
	/** actor.start() 时是否自动发 START */
	autoStart?: boolean
}

// ---------- 实用断言：把可能 undefined 的 input 缩窄 ----------
function assertInput<T>(input: T | undefined): asserts input is T {
	if (input == null) throw new Error('plugin lifecycle invoke: missing input')
}

// ---------- 工厂：创建插件生命周期状态机（仅手动 RETRY） ----------
export function createPluginLifecycle<
	Cfg = unknown,
	P extends BasePlugin = BasePlugin,
>(opts: LifecycleOptions = {}) {
	return setup({
		// —— 一次声明，处处推断 —— //
		types: {
			context: {} as LifecycleCtx<Cfg, P>,
			events: {} as LifecycleEvent | SystemEvents,
			input: {} as LifecycleInput<Cfg, P>,
		},

		// —— 具名异步 actors（签名在这里一次性定型） —— //
		actors: {
			start: fromPromise<void, StartInput<P>>(async ({ input, signal }) => {
				assertInput(input)
				signal.throwIfAborted?.()
				await input.plugin.init?.(signal)
			}),
			stop: fromPromise<void, StopInput<P>>(async ({ input, signal }) => {
				assertInput(input)
				signal.throwIfAborted?.()
				await input.plugin.stop?.(signal)
				await input.plugin.ctx.scope.disposeAll()
			}),
			reload: fromPromise<void, ReloadInput<P>>(async ({ input, signal }) => {
				assertInput(input)
				signal.throwIfAborted?.()
				// 如需热更新：await input.plugin.reload?.(input.pluginCtx, input.patch, signal)
			}),
		},

		// —— 动作：就地改 context，免手写类型 —— //
		actions: {
			maybeAutoStart: ({ self }) => {
				if (opts.autoStart) self.send({ type: 'START' })
			},
			markStarted: ({ context }) => {
				if (!context.startedAt) context.startedAt = Date.now()
				context.err = undefined
				context.attempt = 0
				context.failedStep = undefined
			},
			saveStartError: ({ context, event }) => {
				if (event.type === 'xstate.error.actor') {
					context.err = event.error
					context.failedStep = 'start'
					context.attempt++
				}
			},
			saveReloadError: ({ context, event }) => {
				if (event.type === 'xstate.error.actor') {
					context.err = event.error
					context.failedStep = 'reload'
					context.attempt++
				}
			},
			saveStopError: ({ context, event }) => {
				if (event.type === 'xstate.error.actor') {
					context.err = event.error
					context.failedStep = 'stop'
					context.attempt++
				}
			},
		},

		// —— 守卫：RETRY/STOP 在 failing 中精确分流 —— //
		guards: {
			failedOnStart: ({ context }) => context.failedStep === 'start',
			failedOnReload: ({ context }) => context.failedStep === 'reload',
			failedOnStop: ({ context }) => context.failedStep === 'stop',
			hasEverStarted: ({ context }) => !!context.startedAt,
		},
	}).createMachine({
		id: 'plugin-lifecycle',
		initial: 'idle',

		// setup.types.input 已把 input 定型，可安全展开
		context: ({ input }) => ({
			...input,
			attempt: 0,
			err: undefined,
			startedAt: undefined,
			failedStep: undefined,
		}),

		entry: 'maybeAutoStart',

		states: {
			// —— 冷态：等 START；STOP 直接终态 —— //
			idle: {
				on: {
					START: 'starting',
					STOP: 'stopped',
				},
			},

			// —— 启动阶段：可被 STOP 打断 —— //
			starting: {
				invoke: {
					src: 'start',
					input: ({ context }) => ({
						plugin: context.plugin,
						pluginCtx: context.pluginCtx,
					}),
					onDone: { target: 'running', actions: 'markStarted' },
					onError: { target: 'failing', actions: 'saveStartError' },
				},
				on: {
					STOP: 'stopped',
				},
			},

			// —— 运行态 —— //
			running: {
				on: {
					RELOAD: 'reconfiguring',
					STOP: 'stopping',
					// START 未声明即忽略（幂等）
				},
			},

			// —— 热更新（失败可手动 RETRY 回来） —— //
			reconfiguring: {
				invoke: {
					src: 'reload',
					input: ({ context, event }) => ({
						plugin: context.plugin,
						pluginCtx: context.pluginCtx,
						patch: event.type === 'RELOAD' ? event.patch : undefined,
					}),
					onDone: 'running',
					onError: { target: 'failing', actions: 'saveReloadError' },
				},
				on: {
					STOP: 'stopping',
				},
			},

			// —— 停止：无论 stop 报不报错，都落地 —— //
			stopping: {
				invoke: {
					src: 'stop',
					input: ({ context }) => ({ plugin: context.plugin }),
					onDone: 'stopped',
					onError: { target: 'stopped', actions: 'saveStopError' },
				},
			},

			// —— 失败态：只响应你的手动选择 —— //
			failing: {
				on: {
					// STOP：若之前启动过，尝试优雅停止；否则直接落地
					STOP: [
						{ target: 'stopping', guard: 'hasEverStarted' },
						{ target: 'stopped' },
					],
					// RETRY：按失败阶段精确回跳（无自动退避）
					RETRY: [
						{ target: 'starting', guard: 'failedOnStart' },
						{ target: 'reconfiguring', guard: 'failedOnReload' },
						{ target: 'stopping', guard: 'failedOnStop' },
					],
				},
			},

			// —— 终态 —— //
			stopped: { type: 'final' },
		},
	})
}

// ---------- ActorRef 类型 ----------
export type PluginLifecycleRef<
	Cfg = unknown,
	P extends BasePlugin = BasePlugin,
> = ActorRefFrom<ReturnType<typeof createPluginLifecycle<Cfg, P>>>

// ---------- 便捷 selector（可选） ----------
export const lifecycleSelectors = {
	isRunning: (s: { value: unknown }) =>
		(s as any).matches?.('running') ?? false,
	lastError: <C extends LifecycleCtx>(s: { context: C }) => s.context.err,
	uptime: <C extends LifecycleCtx>(s: { context: C }) =>
		s.context.startedAt ? Date.now() - s.context.startedAt : undefined,
	failedStep: <C extends LifecycleCtx>(s: { context: C }) =>
		s.context.failedStep,
}
