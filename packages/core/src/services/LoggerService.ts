import { type Context, Injectable } from '@pluxel/context'

const serviceName = 'logger' as const
declare module '@pluxel/context' {
	namespace Context {
		interface Services {
			[serviceName]: LoggerService
		}
	}
}

@Injectable({
	key: serviceName,
})
export class LoggerService {
	constructor(public ctx: Context) {}

	private write(level: 'trace' | 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]) {
		// 选一个 console 方法；如果不存在，就用 log
		const fn =
			((console as any)[level] as (...msgs: unknown[]) => void) ?? console.log.bind(console)
		// 在最前面插入 [contextName]
		const info = (this.ctx as Context & { pluginInfo?: Context['pluginInfo'] }).pluginInfo
		const pluginId = info ? info.id : 'root'
		fn(`[${pluginId}:${this.ctx.name}]`, ...args)
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
