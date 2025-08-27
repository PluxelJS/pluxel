import { type Context, Injectable } from '@pluxel/context'

const serviceName = 'logger' as const
declare module '@pluxel/context' {
	export interface Context {
		[serviceName]: LoggerService
	}
}

@Injectable({
	key: serviceName,
})
export class LoggerService {
	constructor(private ctx: Context) {}

	private write(
		level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
		...args: unknown[]
	) {
		// 选一个 console 方法；如果不存在，就用 log
		const fn =
			((console as any)[level] as (...msgs: unknown[]) => void) ??
			console.log.bind(console)
		// 在最前面插入 [contextName]
		fn(`[${this.ctx.name}]`, ...args)
	}

	trace(...args: unknown[]) {
		this.write('trace', ...args)
	}
	debug(...args: unknown[]) {
		this.write('debug', ...args)
	}
	info(...args: unknown[]) {
		this.write('info', ...args)
	}
	warn(...args: unknown[]) {
		this.write('warn', ...args)
	}
	error(...args: unknown[]) {
		this.write('error', ...args)
	}
	// console 没有 fatal，映射到 error
	fatal(...args: unknown[]) {
		this.write('error', ...args)
	}
}
