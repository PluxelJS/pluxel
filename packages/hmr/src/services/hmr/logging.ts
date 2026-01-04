import { getLogger, type Logger as LogtapeLogger } from '@logtape/logtape'
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
	// 细粒度调试默认关闭；需要时配置 debugNamespaces，并在宿主的 LogTape configure() 中将对应 category 的 lowestLevel 设为 debug。
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

export type HmrDebugLogger = LogtapeLogger

function namespaceToCategory(namespace: string): readonly [string, ...string[]] {
	const parts = namespace.split(':').filter(Boolean)
	if (parts.length === 0) return ['pluxel']
	return parts as readonly [string, ...string[]]
}

export function getHmrDebugLogger(namespace: string): HmrDebugLogger {
	return getLogger(namespaceToCategory(namespace))
}

/* --------------------------- 计时与归因 --------------------------- */

export type TimingBucket = 'transform' | 'evaluate' | 'inject'

type NumMap = Map<string, number>
const bump = (m: NumMap, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v)
const nsToMs = (ns: bigint) => Number(ns) / 1e6

export class TimingTracker {
	private readonly debugEntry: HmrDebugLogger | null
	private readonly buckets: Record<TimingBucket, NumMap> = {
		transform: new Map<string, number>(),
		evaluate: new Map<string, number>(),
		inject: new Map<string, number>(),
	}

	constructor(
		private readonly options: {
			formatId: (id: string) => string
			debugEntry?: HmrDebugLogger | null
		},
	) {
		this.debugEntry = options.debugEntry ?? null
	}

	clear() {
		for (const bucket of Object.values(this.buckets)) bucket.clear()
	}

	start(kind: TimingBucket, id: string) {
		const t0 = process.hrtime.bigint()
		return () => {
			const durationMs = nsToMs(process.hrtime.bigint() - t0)
			this.record(kind, id, durationMs)
			return durationMs
		}
	}

	record(kind: TimingBucket, id: string, durationMs: number) {
		bump(this.buckets[kind], id, durationMs)
		if (!this.debugEntry) return
		const total = this.buckets[kind].get(id) ?? durationMs
		this.debugEntry.debug(
			(l) =>
				l`${kind} ${this.options.formatId(id)} ${durationMs.toFixed(3)}ms (agg=${total.toFixed(3)}ms)`,
		)
	}

	top(kind: TimingBucket, n = 5) {
		return [...this.buckets[kind].entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
	}

	snapshot() {
		return {
			transformMs: this.buckets.transform,
			evalMs: this.buckets.evaluate,
			injectMs: this.buckets.inject,
		}
	}
}

type PrettyIdFn = (id: string) => string

const formatTopEntries = (
	entries: Array<[string, number]>,
	prettyId: PrettyIdFn,
	marker?: (id: string) => string | undefined,
): string[] => {
	if (!entries.length) return ['    (none)']

	const msStrings = entries.map(([, ms]) => ms.toFixed(1))
	const msWidth = Math.max(...msStrings.map((s) => s.length))
	const rankWidth = String(entries.length).length
	const tagWidth = Math.max(
		...entries.map(([id]) => (marker?.(id) ?? '').length),
		0,
	)

	return entries.map(([id, ms], i) => {
		const tag = marker?.(id)
		const tagCol = tagWidth ? (tag ? tag.padEnd(tagWidth) : ''.padEnd(tagWidth)) : ''
		const rank = String(i + 1).padStart(rankWidth)
		const msStr = ms.toFixed(1).padStart(msWidth)
		const tagSep = tagWidth ? `  ${tagCol}  ` : '  '
		return `    ${rank}. ${msStr}ms${tagSep}${prettyId(id)}`
	})
}

export const formatAttributionReport = (params: {
	changed: string
	targets: string[]
	timing: TimingTracker
	prettyId: PrettyIdFn
}) => {
	const lines = buildAttributionLines(params)
	return lines.join('\n')
}

export function buildAttributionLines(params: {
	changed: string
	targets: string[]
	timing: TimingTracker
	prettyId: PrettyIdFn
}): string[] {
	const targetSet = new Set(params.targets)
	const marker = (id: string) =>
		targetSet.has(id) ? 'target' : id === params.changed ? 'changed' : undefined

	const transformTop = params.timing.top('transform', 5)
	const evaluateTop = params.timing.top('evaluate', 5)
	const injectTop = params.timing.top('inject', 5)

	return [
		`[HMR] attribution: ${params.prettyId(params.changed)} → ${params.targets.length} targets`,
		'  transform (top 5):',
		...formatTopEntries(transformTop, params.prettyId, marker),
		'  evaluate (top 5):',
		...formatTopEntries(evaluateTop, params.prettyId, marker),
		'  inject (top 5):',
		...formatTopEntries(injectTop, params.prettyId, marker),
	]
}

export function logAttributionReport(
	logger: Pick<
		LogtapeLogger,
		'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
	>,
	params: Parameters<typeof buildAttributionLines>[0],
	opts: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' } = {},
) {
	const level = opts.level ?? 'info'
	const log = logger[level] as unknown as (message: string) => void
	// Use the string overload so the message is printed as-is (no util.inspect quoting),
	// while keeping it a single log record.
	log.call(logger, formatAttributionReport(params))
}
