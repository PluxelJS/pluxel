// file: src/machine.runtime.ts

import * as cb from './callbacks'
import { defineMachine } from './defineMachine.macro'

export const fsm = defineMachine({
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
	},

	impl: {
		callbacks: {
			onStart: cb.onStart,
		},
		hooks: {
			onEnterRunning: cb.onEnterRunning,
		},
	},

	abortOnStateChange: true,
})
