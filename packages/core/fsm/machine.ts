// file: src/machine.ts

import * as cb from './callbacks'
import { bakeMachine } from './defineMachine.macro' with { type: 'macro' }
import { hydrateMachine } from './defineMachine.macro'

const impl = {
	callbacks: {
		onStart: cb.onStart,
	},
	hooks: {
		onEnterRunning: cb.onEnterRunning,
	},
}

export const fsm = hydrateMachine(
	bakeMachine({
		states: ['idle', 'running', 'stopped'] as const,
		events: ['start', 'stop'] as const,
		init: 'idle',

		transitions: [
			['idle', 'start', 'running', 'onStart'],
			['running', 'stop', 'stopped'],
		] as const,

		hooks: {
			enter: {
				running: 'onEnterRunning',
			},
			// exit: {} // 你可以完全不写
		},

		abortOnStateChange: true,
		strictDuplicateEdge: true,
	}),
	impl,
)
