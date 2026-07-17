declare module 'tinypool' {
	export type TinypoolOptions = {
		filename: string
		minThreads?: number
		maxThreads?: number
		idleTimeout?: number
	}

	export class Tinypool {
		constructor(options: TinypoolOptions)
		run<T = unknown, R = unknown>(task: T): Promise<R>
		destroy(): Promise<void>
	}

	export default Tinypool
}
