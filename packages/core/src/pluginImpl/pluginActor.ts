import { setup, fromPromise, fromCallback, type ActorRefFrom } from 'xstate'
import type { BasePlugin } from './BasePlugin'

/* ────────────────────────── 外部事件 ────────────────────────── */
export type LifecycleEvent =
	| { type: 'START' }
	| { type: 'STOP' }
	| { type: 'RELOAD'; patch?: unknown }
	| { type: 'RETRY' }

/* ───────────────────── 系统事件（onError/onDone） ───────────────────── */
type SystemEvents =
	| { type: string; error: unknown } // v5: 形如 xstate.error.actor.start
	| { type: 'xstate.done.actor'; output?: unknown }

/* ────────────────────────── 被调用 actor 的输入 ────────────────────────── */
type StartInput<P extends BasePlugin> = { plugin: P }
type StopInput<P extends BasePlugin> = { plugin: P }
type ReloadInput<P extends BasePlugin> = { plugin: P; patch?: unknown }

/* ────────────────────────── 机器输入 & 上下文 ────────────────────────── */
export interface LifecycleInput<
	Cfg = unknown,
	P extends BasePlugin = BasePlugin,
> {
	id: unknown
	plugin: P
	config?: Cfg
}

type FailedStep = 'start' | 'reload' | 'stop' | 'runtime' | undefined

interface LifecycleCtx<Cfg = unknown, P extends BasePlugin = BasePlugin>
	extends LifecycleInput<Cfg, P> {
	attempt: number // 连续失败次数（成功后清零）
	err?: Error // 最近一次错误（保真 Error）
	startedAt?: number // 首次成功启动时间戳
	failedStep: FailedStep // 失败发生在哪个阶段
}

/* ────────────────────────── 选项 ────────────────────────── */
export interface LifecycleOptions {
	/** actor.start() 时是否自动发 START */
	autoStart?: boolean
	/** 运行态是否订阅插件侧的错误上报（用于延迟抛错） */
	useErrorChannel?: boolean
}

/* ────────────────────────── 实用函数 ────────────────────────── */
function assertInput<T>(input: T | undefined): asserts input is T {
	if (input == null) throw new Error('plugin lifecycle invoke: missing input')
}

/** 循环安全的 JSON 序列化（尽量给出可读 message） */
function safeStringify(x: unknown): string {
	try {
		const seen = new WeakSet<object>()
		return JSON.stringify(
			x,
			(_, v) => {
				if (typeof v === 'object' && v !== null) {
					if (seen.has(v)) return '[Circular]'
					seen.add(v)
				}
				return v
			},
			2,
		)
	} catch {
		return Object.prototype.toString.call(x)
	}
}

/** 把任意值转为 Error，并把原值塞到 cause */
const toError = (e: unknown): Error => {
	if (e instanceof Error) return e
	const msg = typeof e === 'string' ? e : safeStringify(e)

	return new Error(msg, { cause: e })
}

/**
 * 创建插件生命周期状态机（XState v5）
 * - start/reload/stop 的错误均写入 context.err，失败进入 `failing`
 * - STOP 统一走 `stopping`，永远执行 stop + disposeAll（即使没启动过）
 * - 可选运行期错误通道（ctx.onError）：上报 `ASYNC_ERROR` → failing
 */
export function createPluginLifecycle<
	Cfg = unknown,
	P extends BasePlugin = BasePlugin,
>(opts: LifecycleOptions = {}) {
	return setup({
		types: {
			context: {} as LifecycleCtx<Cfg, P>,
			events: {} as
				| LifecycleEvent
				| SystemEvents
				| { type: 'ASYNC_ERROR'; error: unknown },
			input: {} as LifecycleInput<Cfg, P>,
		},

		actors: {
			start: fromPromise<void, StartInput<P>>(async ({ input, signal }) => {
				assertInput(input)
				try {
					signal.throwIfAborted?.()
					const { plugin } = input
					plugin.ctx.emitWithContext?.(plugin, 'beforeStart', plugin)
					// 同步/异步抛错都压入 microtask 链进行捕获
					await Promise.resolve(plugin.init?.(signal))
				} catch (e) {
					throw toError(e)
				} finally {
					// 若启动阶段被取消（例如外部 STOP），兜底做一次资源回收
					if (signal.aborted) {
						try {
							await Promise.resolve(input.plugin.ctx.scope?.disposeAll())
						} catch {
							/* 忽略清理异常 */
						}
					}
				}
			}),

			stopOrCleanup: fromPromise<void, StopInput<P>>(
				async ({ input, signal }) => {
					assertInput(input)
					try {
						// 即使“没启动过”，stop 也应当是幂等且容错的
						await Promise.resolve(input.plugin.stop?.(signal))
					} catch (e) {
						throw toError(e)
					} finally {
						// 无条件清理作用域，确保回收
						try {
							await Promise.resolve(input.plugin.ctx.scope?.disposeAll())
						} catch {
							/* 忽略清理异常 */
						}
					}
				},
			),

			reload: fromPromise<void, ReloadInput<P>>(async ({ input, signal }) => {
				assertInput(input)
				try {
					signal.throwIfAborted?.()
					// 如需热更新请在此实现：
					// await Promise.resolve(input.plugin.reload?.(input.patch, signal))
				} catch (e) {
					throw toError(e)
				}
			}),

			// 运行期错误通道：插件侧可通过 ctx.onError(cb) 上报
			errorChannel: fromCallback<
				{ type: 'ASYNC_ERROR'; error: unknown },
				{ plugin: P }
			>(({ input, sendBack }) => {
				const onError = (input?.plugin as any)?.ctx?.onError as
					| ((cb: (e: unknown) => void) => (() => void) | void)
					| undefined

				if (typeof onError !== 'function') return () => {}

				const unsub = onError((err) => {
					sendBack({ type: 'ASYNC_ERROR', error: err })
				})
				return () => {
					try {
						;(unsub as any)?.()
					} catch {
						/* 忽略 */
					}
				}
			}),
		},

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

			// —— 修复点：不与固定事件名做等值比较，只要带 error 字段就记录 —— //
			saveStartError: ({ context, event }) => {
				const anyEv = event as any
				if ('error' in anyEv) {
					context.err = toError(anyEv.error)
					context.failedStep = 'start'
					context.attempt++
				}
			},

			saveReloadError: ({ context, event }) => {
				const anyEv = event as any
				if ('error' in anyEv) {
					context.err = toError(anyEv.error)
					context.failedStep = 'reload'
					context.attempt++
				}
			},

			// stop 阶段错误不覆盖之前的根因；但记一次 attempt
			saveStopError: ({ context, event }) => {
				const anyEv = event as any
				if ('error' in anyEv) {
					if (context.err == null) {
						context.err = toError(anyEv.error)
						context.failedStep = 'stop'
					}
					context.attempt++
				}
			},

			// 运行期错误：默认覆盖（也可改成仅首错误）
			saveAsyncError: ({ context, event }) => {
				if (event.type === 'ASYNC_ERROR') {
					context.err = toError(event.error)
					context.failedStep = 'runtime'
					context.attempt++
				}
			},
		},

		guards: {
			failedOnStart: ({ context }) => context.failedStep === 'start',
			failedOnReload: ({ context }) => context.failedStep === 'reload',
			failedOnStop: ({ context }) => context.failedStep === 'stop',
			hasEverStarted: ({ context }) => !!context.startedAt,
		},
	}).createMachine({
		id: 'plugin-lifecycle',
		initial: 'idle',

		context: ({ input }) => ({
			...input,
			attempt: 0,
			err: undefined,
			startedAt: undefined,
			failedStep: undefined,
		}),

		entry: 'maybeAutoStart',

		states: {
			/* ─── 冷态 ─── */
			idle: {
				on: {
					START: 'starting',
					STOP: 'stopping', // 统一走 stopping，确保清理
				},
			},

			/* ─── 启动 ─── */
			starting: {
				invoke: {
					id: 'start', // 显式 id，便于调试与事件追踪
					src: 'start',
					input: ({ context }) => ({ plugin: context.plugin }),
					onDone: { target: 'running', actions: 'markStarted' },
					onError: { target: 'failing', actions: 'saveStartError' },
				},
				on: { STOP: 'stopping' },
			},

			/* ─── 运行 ─── */
			running: {
				invoke: opts.useErrorChannel
					? {
							id: 'errorChannel',
							src: 'errorChannel',
							input: ({ context }) => ({ plugin: context.plugin }),
						}
					: undefined,
				on: {
					ASYNC_ERROR: { target: 'failing', actions: 'saveAsyncError' },
					RELOAD: 'reconfiguring',
					STOP: 'stopping',
				},
			},

			/* ─── 热更新 ─── */
			reconfiguring: {
				invoke: {
					id: 'reload',
					src: 'reload',
					input: ({ context, event }) => ({
						plugin: context.plugin,
						patch: event.type === 'RELOAD' ? event.patch : undefined,
					}),
					onDone: 'running',
					onError: { target: 'failing', actions: 'saveReloadError' },
				},
				on: { STOP: 'stopping' },
			},

			/* ─── 停止（必清理）─── */
			stopping: {
				invoke: {
					id: 'stopOrCleanup',
					src: 'stopOrCleanup',
					input: ({ context }) => ({ plugin: context.plugin }),
					onDone: 'stopped',
					onError: { target: 'stopped', actions: 'saveStopError' },
				},
			},

			/* ─── 失败：只响应你的手动选择 ─── */
			failing: {
				on: {
					STOP: 'stopping',
					RETRY: [
						{ target: 'starting', guard: 'failedOnStart' },
						{ target: 'reconfiguring', guard: 'failedOnReload' },
						{ target: 'stopping', guard: 'failedOnStop' },
					],
				},
			},

			/* ─── 终态 ─── */
			stopped: { type: 'final' },
		},
	})
}

/* ────────────────────────── ActorRef 类型 ────────────────────────── */
export type PluginLifecycleRef<
	Cfg = unknown,
	P extends BasePlugin = BasePlugin,
> = ActorRefFrom<ReturnType<typeof createPluginLifecycle<Cfg, P>>>

/* ────────────────────────── 便捷 selector ────────────────────────── */
export const lifecycleSelectors = {
	isRunning: (s: { value: unknown }) =>
		(s as any).matches?.('running') ?? false,
	lastError: <C extends LifecycleCtx>(s: { context: C }) => s.context.err,
	uptime: <C extends LifecycleCtx>(s: { context: C }) =>
		s.context.startedAt ? Date.now() - s.context.startedAt : undefined,
	failedStep: <C extends LifecycleCtx>(s: { context: C }) =>
		s.context.failedStep,
}
