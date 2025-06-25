// src/logger.ts
import pino, { type Logger, type LoggerOptions } from 'pino'
import pinoCaller from 'pino-caller'
export * from 'pino'

// 判断是否 dev，注意你的项目里 NODE_ENV 需要在启动脚本里设为 "development"
const isDev =
	process.env.NODE_ENV === undefined
		? true
		: process.env.NODE_ENV === 'development'

/**
 * 开发环境下，我们：
 *  1) 用 pino-caller 给每次调用打上 file/line 信息
 *  2) 用 pino-pretty 的 transport/messageFormat 格式化输出，
//     并把 file:line 拼到末尾
 */
export function createLogger(opts: LoggerOptions): Logger {
	// 1. 基础 Logger
	const base = pino({
		...opts,
		// 生产环境直接走 JSON 输出
		transport: isDev
			? {
					target: 'pino-pretty',
					options: {
						colorize: true,
						// 忽略 pid, hostname，大家常用设置
						ignore: 'pid,hostname',
					},
				}
			: undefined,
	})

	// 2. 把基础 logger 包裹一下，让它在每次调用时捕获堆栈
	//    wrap=false 表示直接用 bind，不替换方法签名
	return isDev ? pinoCaller(base) : base
}
