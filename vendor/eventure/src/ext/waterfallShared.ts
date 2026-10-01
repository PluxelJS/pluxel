import type { EventDescriptor, EventListener } from '../types'

export type SplitWaterfall<D extends EventDescriptor> = D extends (
	...args: [...infer P, infer N]
) => infer R
	? N extends (...args: any[]) => any
		? { args: P; next: N; ret: R }
		: never
	: never

export type WFResult<R> = { ok: true; value: R } | { ok: false; value: R }

const noopInner = () => {}

export function runWaterfall<D extends EventDescriptor>(
	listeners: EventListener<D>[],
	args: any[],
) {
	const last = args[args.length - 1]
	const hasInner = typeof last === 'function'
	const inner = hasInner
		? (args.pop() as (...innerArgs: any[]) => any)
		: noopInner
	const callArgs = args

	let idx = 0
	let interrupted = false
	const listenerCount = listeners.length

	function dispatch(this: any): any {
		if (idx < listenerCount) {
			const listener = listeners[idx++] as any
			let nextCalled = false
			function next(this: any) {
				nextCalled = true
				return dispatch.apply(undefined, arguments as any)
			}

			let ret: any
			switch (arguments.length) {
				case 0:
					ret = listener(next)
					break
				case 1:
					ret = listener(arguments[0], next)
					break
				case 2:
					ret = listener(arguments[0], arguments[1], next)
					break
				case 3:
					ret = listener(arguments[0], arguments[1], arguments[2], next)
					break
				case 4:
					ret = listener(
						arguments[0],
						arguments[1],
						arguments[2],
						arguments[3],
						next,
					)
					break
				default: {
					const argc = arguments.length
					const argv = new Array(argc + 1)
					for (let i = 0; i < argc; i++) argv[i] = arguments[i]
					argv[argc] = next
					ret = listener.apply(undefined, argv)
				}
			}

			if (!nextCalled) interrupted = true
			return ret
		}

		switch (arguments.length) {
			case 0:
				return inner()
			case 1:
				return inner(arguments[0])
			case 2:
				return inner(arguments[0], arguments[1])
			case 3:
				return inner(arguments[0], arguments[1], arguments[2])
			case 4:
				return inner(arguments[0], arguments[1], arguments[2], arguments[3])
			default:
				return inner.apply(undefined, arguments as any)
		}
	}

	const result = dispatch.apply(undefined, callArgs as any)
	return { ok: !interrupted, value: result }
}
