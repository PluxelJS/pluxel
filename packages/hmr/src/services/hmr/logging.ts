import { createDebug, type Debugger, type DebugOptions } from 'obug'
import {
	array,
	type InferOutput,
	object,
	optional,
	parse,
	picklist,
	union,
	boolean as vBoolean,
} from 'valibot'

/**
 * 可启用的 debug namespace（细粒度调试，默认关闭）
 * - modules: 每模块执行详情（eval/inject 耗时）
 * - time: 计时汇总
 * - time:entry: 每条计时记录（最细粒度）
 * - warmup: 预热阶段文件列表
 * - batch: 批处理详情（受影响文件、targets）
 * - cache: 缓存失效详情
 * - graph: 依赖图遍历详情
 */
export const HMR_DEBUG_NAMESPACES = [
	'pluxel:hmr:modules',
	'pluxel:hmr:time',
	'pluxel:hmr:time:entry',
	'pluxel:hmr:warmup',
	'pluxel:hmr:batch',
	'pluxel:hmr:cache',
	'pluxel:hmr:graph',
] as const

export const HMRDebugNamespaceSchema = picklist(HMR_DEBUG_NAMESPACES)
export type HMRDebugNamespace = InferOutput<typeof HMRDebugNamespaceSchema>
export type HMRDebugNamespaceInput = HMRDebugNamespace | readonly HMRDebugNamespace[]

export const HMRLogConfigSchema = object({
	useColors: optional(vBoolean()),
	debugNamespaces: optional(union([HMRDebugNamespaceSchema, array(HMRDebugNamespaceSchema)])),
})
export type HMRLogConfig = InferOutput<typeof HMRLogConfigSchema>

export interface ResolvedHMRLogConfig {
	useColors: boolean
	debugNamespaces?: HMRDebugNamespace[]
}

export const DEFAULT_LOG_CONFIG: ResolvedHMRLogConfig = {
	useColors: true,
	// 细粒度调试默认关闭；需要时设置 DEBUG=pluxel:hmr:* 或配置 debugNamespaces
	debugNamespaces: [],
}

export function resolveHmrLogConfig(input?: HMRLogConfig): ResolvedHMRLogConfig {
	const parsed = parse(HMRLogConfigSchema, input ?? {})
	let debugNamespaces: HMRDebugNamespace[] | undefined
	if (parsed.debugNamespaces) {
		const list = Array.isArray(parsed.debugNamespaces)
			? parsed.debugNamespaces
			: [parsed.debugNamespaces]
		debugNamespaces = Array.from(new Set(list))
	}
	return {
		useColors: parsed.useColors ?? DEFAULT_LOG_CONFIG.useColors,
		debugNamespaces: debugNamespaces ?? DEFAULT_LOG_CONFIG.debugNamespaces,
	}
}

export function toDebugNamespaceString(list?: HMRDebugNamespace[]): string | undefined {
	if (!list?.length) return undefined
	return list.join(',')
}

/* -------------------------------- obug 工厂 -------------------------------- */

// ANSI 颜色码
const ANSI = {
	reset: '\u001B[0m',
	bold: '\u001B[1m',
	dim: '\u001B[2m',
	// 前景色
	yellow: '\u001B[33m',
	brightYellow: '\u001B[93m',
	cyan: '\u001B[36m',
	brightCyan: '\u001B[96m',
	green: '\u001B[32m',
	brightGreen: '\u001B[92m',
	magenta: '\u001B[35m',
	brightMagenta: '\u001B[95m',
	gray: '\u001B[90m',
} as const

/**
 * 创建 HMR 专用的 debug 实例
 * - 自定义 formatters：%t（时间高亮）、%p（路径高亮）、%n（数字高亮）、%b（布尔高亮）
 * - 去掉末尾的 +diff 后缀（冗余）
 */
export function createHmrDebug(namespace: string, useColors: boolean): Debugger {
	const opts: DebugOptions = {
		useColors,
		formatters: {
			// %t - 时间（毫秒），高亮黄色
			t(v: number) {
				const formatted = typeof v === 'number' ? v.toFixed(1) : String(v)
				return this.useColors ? `${ANSI.brightYellow}${formatted}ms${ANSI.reset}` : `${formatted}ms`
			},
			// %T - 时间（毫秒），高亮但不带 ms 后缀
			T(v: number) {
				const formatted = typeof v === 'number' ? v.toFixed(3) : String(v)
				return this.useColors ? `${ANSI.brightYellow}${formatted}${ANSI.reset}` : formatted
			},
			// %p - 路径，高亮青色
			p(v: string) {
				return this.useColors ? `${ANSI.cyan}${v}${ANSI.reset}` : v
			},
			// %n - 数字，高亮绿色
			n(v: number) {
				return this.useColors ? `${ANSI.brightGreen}${v}${ANSI.reset}` : String(v)
			},
			// %b - 布尔，高亮
			b(v: boolean) {
				if (!this.useColors) return String(v)
				return v ? `${ANSI.green}true${ANSI.reset}` : `${ANSI.gray}false${ANSI.reset}`
			},
			// %l - 列表（数组），每项一行
			l(v: string[]) {
				if (!Array.isArray(v) || v.length === 0) return '(empty)'
				const indent = '    '
				const items = v.map((item) => {
					return this.useColors ? `${indent}${ANSI.cyan}${item}${ANSI.reset}` : `${indent}${item}`
				})
				return `\n${items.join('\n')}`
			},
		},
		formatArgs(this: Debugger, _diff: number, args: [string, ...unknown[]]) {
			if (this.useColors) {
				const c = this.color as number
				const colorCode = `\u001B[3${c < 8 ? c : `8;5;${c}`}`
				const prefix = `  ${colorCode};1m${this.namespace} ${ANSI.reset}`
				args[0] = prefix + args[0].split('\n').join(`\n${prefix}`)
				// 不添加 +diff 后缀
			} else {
				args[0] = `${this.namespace} ${args[0]}`
			}
		},
	}

	return createDebug(namespace, opts)
}

/**
 * 创建一组相关的 debug 实例
 */
export function createHmrDebugGroup<T extends Record<string, string>>(
	namespaces: T,
	useColors: boolean,
): { [K in keyof T]: Debugger } {
	const result = {} as { [K in keyof T]: Debugger }
	for (const [key, ns] of Object.entries(namespaces)) {
		result[key as keyof T] = createHmrDebug(ns, useColors)
	}
	return result
}
