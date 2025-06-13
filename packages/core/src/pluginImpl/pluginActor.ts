// pluginActor.ts
import { assign, createActor, setup } from 'xstate'

/** 插件可能发生的错误 **/
export interface PluginError {
	type: 'instantiation' | 'initialization' | 'uninstall'
	pluginId: string
	cause: unknown
}

/** Actor 上下文 **/
export interface PluginCtx {
	id: string
	error?: PluginError

	// 记录各阶段开始时间
	instantiateStart?: number
	initStart?: number
	uninstallStart?: number

	// 存放各阶段耗时
	instantiateDuration?: number
	initDuration?: number
	uninstallDuration?: number
}

/** Actor 支持的所有事件 **/
export type PluginEvent =
	| { type: 'START_INSTANTIATE' }
	| { type: 'INSTANTIATE_SUCCESS' }
	| { type: 'INSTANTIATE_FAILURE'; error: unknown }
	| { type: 'START_INIT' }
	| { type: 'INIT_SUCCESS' }
	| { type: 'INIT_FAILURE'; error: unknown }
	| { type: 'START_UNINSTALL' }
	| { type: 'UNINSTALL_SUCCESS' }
	| { type: 'UNINSTALL_FAILURE'; error: unknown }
	| { type: 'RESET' }

/**
 * 1) 用 setup 显式定义所有 actions
 */
const setupFunction = setup({
	types: {
		input: {} as { id: string },
		context: {} as PluginCtx,
		events: {} as PluginEvent,
	},
	actions: {
		// 清除错误
		clearError: assign({
			error: () => undefined,
		}),

		// instantiation 阶段
		recordInstantiateStart: assign({
			instantiateStart: () => Date.now(),
		}),
		recordInstantiateDuration: assign(({ context: ctx }) => ({
			instantiateDuration:
				ctx.instantiateStart != null
					? Date.now() - ctx.instantiateStart
					: undefined,
		})),

		// initialization 阶段
		recordInitStart: assign({
			initStart: () => Date.now(),
		}),
		recordInitDuration: assign(({ context: ctx }) => ({
			initDuration:
				ctx.initStart != null ? Date.now() - ctx.initStart : undefined,
		})),

		// uninstall 阶段
		recordUninstallStart: assign({
			uninstallStart: () => Date.now(),
		}),
		recordUninstallDuration: assign(({ context: ctx }) => ({
			uninstallDuration:
				ctx.uninstallStart != null
					? Date.now() - ctx.uninstallStart
					: undefined,
		})),
	},
})

/**
 * 2) 在 machine 定义里，只用字符串引用这些显式 action
 */
const machine = setupFunction.createMachine({
	id: 'plugin',
	initial: 'idle',
	context: ({ input }) => ({
		id: input.id,
		error: undefined,
	}),

	states: {
		idle: {
			on: {
				START_INSTANTIATE: 'instantiating',
			},
		},

		instantiating: {
			entry: ['clearError', 'recordInstantiateStart'],
			on: {
				INSTANTIATE_SUCCESS: {
					target: 'instantiated',
					actions: 'recordInstantiateDuration',
				},
				INSTANTIATE_FAILURE: {
					target: 'instantiateFailed',
					actions: [
						'recordInstantiateDuration',
						assign({
							error: ({ context, event }) => ({
								type: 'instantiation',
								pluginId: context.id,
								cause: event.error,
							}),
						}),
					],
				},
			},
		},

		instantiateFailed: {
			entry: 'clearError',
			on: {
				RESET: {
					target: 'idle',
					actions: 'clearError',
				},
			},
		},

		instantiated: {
			on: {
				START_INIT: 'initializing',
			},
		},

		initializing: {
			entry: ['clearError', 'recordInitStart'],
			on: {
				INIT_SUCCESS: {
					target: 'initialized',
					actions: 'recordInitDuration',
				},
				INIT_FAILURE: {
					target: 'initFailed',
					actions: [
						'recordInitDuration',
						assign({
							error: ({ context, event }) => ({
								type: 'initialization',
								pluginId: context.id,
								cause: event.error,
							}),
						}),
					],
				},
			},
		},

		initFailed: {
			entry: 'clearError',
			on: {
				RESET: {
					target: 'instantiated',
					actions: 'clearError',
				},
			},
		},

		initialized: {
			on: {
				START_UNINSTALL: 'uninstalling',
			},
		},

		uninstalling: {
			entry: ['clearError', 'recordUninstallStart'],
			on: {
				UNINSTALL_SUCCESS: {
					target: 'uninstalled',
					actions: 'recordUninstallDuration',
				},
				UNINSTALL_FAILURE: {
					target: 'uninstallFailed',
					actions: [
						'recordUninstallDuration',
						assign({
							error: ({ context, event }) => ({
								type: 'uninstall',
								pluginId: context.id,
								cause: event.error,
							}),
						}),
					],
				},
			},
		},

		uninstallFailed: {
			entry: 'clearError',
			on: {
				RESET: {
					target: 'initialized',
					actions: 'clearError',
				},
			},
		},

		uninstalled: {
			entry: 'clearError',
			always: 'idle',
		},
	},
})

/**
 * 3) spawn actor 并启动
 */
export function spawnPluginActor(id: string) {
	const actor = createActor(machine, { input: { id } })
	actor.subscribe((snapshot) => {
		console.log(
			`Plugin[${id}] 状态=${snapshot.value}`,
			'instantiateDuration=',
			snapshot.context.instantiateDuration,
			'initDuration=',
			snapshot.context.initDuration,
			'uninstallDuration=',
			snapshot.context.uninstallDuration,
			'error=',
			snapshot.context.error,
		)
	})
	actor.start()
	return actor
}

import { PluginA } from '@/plugins/PluginA'
// — 使用示例 —
const plugin = spawnPluginActor(PluginA.name)
plugin.send({ type: 'START_INSTANTIATE' })
plugin.send({ type: 'INSTANTIATE_SUCCESS' })
plugin.send({ type: 'START_INIT' })
plugin.send({ type: 'INIT_SUCCESS' })
plugin.send({ type: 'START_UNINSTALL' })
plugin.send({ type: 'UNINSTALL_SUCCESS' })
