// file: test/fixtures/macro-entry.ts
import { bakeMachine } from '../../defineMachine.macro' with { type: 'macro' }
import { hydrateMachine } from '../../defineMachine.macro'

export function onStart(name: string) {
	// no-op
}

export function onEnterRunning(info: { signal?: AbortSignal }) {
	const { signal } = info
	if (!signal) return

	const t = setInterval(() => {}, 5)
	signal.addEventListener('abort', () => clearInterval(t), { once: true })
}

const impl = {
	callbacks: { onStart },
	hooks: { onEnterRunning },
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
			enter: { running: 'onEnterRunning' },
		},

		abortOnStateChange: true,
	}),
	impl,
)
