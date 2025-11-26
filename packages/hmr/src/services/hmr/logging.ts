import {
	array,
	boolean as vBoolean,
	type InferOutput,
	object,
	optional,
	parse,
	picklist,
	union,
} from 'valibot'

/**
 * 可启用的 debug namespace（细粒度调试，默认关闭）
 * - modules: 每模块执行详情
 * - time: 计时汇总
 * - time:entry: 每条计时记录（最细粒度）
 */
export const HMR_DEBUG_NAMESPACES = [
	'pluxel:hmr:modules',
	'pluxel:hmr:time',
	'pluxel:hmr:time:entry',
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
	// 细粒度调试默认关闭；需要时设置 DEBUG=pluxel:hmr:modules 或配置 debugNamespaces
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
