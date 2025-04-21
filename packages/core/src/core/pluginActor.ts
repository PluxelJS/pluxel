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
 * 1) setup 链接类型 & 导入 assign
 */
const setupFunction = setup({
	types: {
		input: {} as { id: string },
		context: {} as PluginCtx,
		events: {} as PluginEvent,
	},
})

const machine = setupFunction.createMachine({
	id: 'plugin',
	initial: 'idle',
	context: ({ input }) => ({ id: input.id, error: undefined }),

	states: {
		idle: {
			on: {
				START_INSTANTIATE: 'instantiating',
				RESET: {
					target: 'idle',
					actions: assign({ error: () => undefined }),
				},
			},
		},

		instantiating: {
			// 进来就清除上一轮错误
			entry: assign({ error: () => undefined }),
			on: {
				INSTANTIATE_SUCCESS: 'instantiated',
				INSTANTIATE_FAILURE: {
					target: 'instantiateFailed',
					actions: assign({
						error: ({ context, event }) => {
							const { error: cause } = event as {
								type: 'INSTANTIATE_FAILURE'
								error: unknown
							}
							return { type: 'instantiation', pluginId: context.id, cause }
						},
					}),
				},
				RESET: {
					target: 'idle',
					actions: assign({ error: () => undefined }),
				},
			},
		},

		instantiateFailed: {
			entry: assign({ error: () => undefined }),
			on: {
				RESET: {
					target: 'idle',
					actions: assign({ error: () => undefined }),
				},
			},
		},

		instantiated: {
			on: {
				START_INIT: 'initializing',
				RESET: {
					target: 'idle',
					actions: assign({ error: () => undefined }),
				},
			},
		},

		initializing: {
			entry: assign({ error: () => undefined }),
			on: {
				INIT_SUCCESS: 'initialized',
				INIT_FAILURE: {
					target: 'initFailed',
					actions: assign({
						error: ({ context, event }) => {
							const { error: cause } = event as {
								type: 'INIT_FAILURE'
								error: unknown
							}
							return { type: 'initialization', pluginId: context.id, cause }
						},
					}),
				},
				RESET: {
					target: 'instantiated',
					actions: assign({ error: () => undefined }),
				},
			},
		},

		initFailed: {
			entry: assign({ error: () => undefined }),
			on: {
				RESET: {
					target: 'instantiated',
					actions: assign({ error: () => undefined }),
				},
			},
		},

		initialized: {
			on: {
				START_UNINSTALL: 'uninstalling',
				RESET: {
					target: 'idle',
					actions: assign({ error: () => undefined }),
				},
			},
		},

		uninstalling: {
			entry: assign({ error: () => undefined }),
			on: {
				UNINSTALL_SUCCESS: 'uninstalled',
				UNINSTALL_FAILURE: {
					target: 'uninstallFailed',
					actions: assign({
						error: ({ context, event }) => {
							const { error: cause } = event as {
								type: 'UNINSTALL_FAILURE'
								error: unknown
							}
							return { type: 'uninstall', pluginId: context.id, cause }
						},
					}),
				},
				RESET: {
					target: 'initialized',
					actions: assign({ error: () => undefined }),
				},
			},
		},

		uninstallFailed: {
			entry: assign({ error: () => undefined }),
			on: {
				RESET: {
					target: 'initialized',
					actions: assign({ error: () => undefined }),
				},
			},
		},

		// 卸载完成后立即清除错误并回到 idle
		uninstalled: {
			entry: assign({ error: () => undefined }),
			always: 'idle',
		},
	},
})

/**
 * 2) spawn actor 并启动
 */
export function spawnPluginActor(id: string) {
	const actor = createActor(machine, { input: { id } })
	actor.subscribe((snapshot) => {
		console.log(
			`Plugin[${id}] 状态=${snapshot.value}`,
			'error=',
			snapshot.context.error,
		)
	})
	actor.start()
	return actor
}

// —— 用法示例 ——
// const plugin = spawnPluginActor('my-plugin')
// plugin.send('START_INSTANTIATE')
// plugin.send('INSTANTIATE_SUCCESS')
// plugin.send('START_INIT')
// plugin.send('INIT_SUCCESS')
// plugin.send('START_UNINSTALL')
// plugin.send('UNINSTALL_SUCCESS') // 自动回到 idle

import { PluginA } from '@/plugins/PluginA'
// — 使用示例 —
const plugin = spawnPluginActor(PluginA.name)
plugin.send({ type: 'START_INSTANTIATE' })
plugin.send({ type: 'INSTANTIATE_SUCCESS' })
plugin.send({ type: 'START_INIT' })
plugin.send({ type: 'INIT_SUCCESS' })
plugin.send({ type: 'START_UNINSTALL' })
plugin.send({ type: 'UNINSTALL_SUCCESS' })
