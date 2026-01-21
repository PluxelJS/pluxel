// packages/hmr/tests/demo/PluginBuiltinShowcase.ts
// 展示型插件：尽量不注册自定义组件，仅使用宿主内置能力（builtin UI + Config）

import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { RpcTarget } from '@pluxel/hmr/capnweb'
import { f, v } from '@pluxel/hmr/config'
import type { SseChannel } from '@pluxel/hmr/services'
import { doc } from '@pluxel/hmr/web'

const MIN_REFRESH_MS = 250
const MAX_REFRESH_MS = 10_000

const UPTIME_STYLES = ['compact', 'full'] as const
type UptimeStyle = (typeof UPTIME_STYLES)[number]

const TIME_UNITS = ['auto', 's', 'ms'] as const
type TimeUnit = (typeof TIME_UNITS)[number]

const SEPARATORS = ['space', 'colon', 'dot'] as const
type Separator = (typeof SEPARATORS)[number]

const LABEL_STYLES = ['short', 'full', 'verbose'] as const
type LabelStyle = (typeof LABEL_STYLES)[number]

const SECTION_FORMAT = { id: 'format', title: '格式', description: '时间显示格式' }
const SECTION_LABELS = { id: 'labels', title: '文案', description: '前后缀与展示文本' }
const SECTION_ADVANCED = { id: 'advanced', title: '高级', description: '长表单测试' }

const DEFAULTS = {
	display: { refreshMs: 1000 },
	behavior: { tickStep: 1, maxTicks: 0, autoPauseAtMax: false },
	format: {
		uptimeStyle: 'compact' as UptimeStyle,
		showMs: false,
		timeUnit: 'auto' as TimeUnit,
		separator: 'space' as Separator,
		padZeros: false,
		minDigits: 2,
		labelStyle: 'short' as LabelStyle,
		prefix: '',
		suffix: '',
		uppercaseUnits: false,
		template: '',
		unitAliases: { d: 'day', h: 'hr', m: 'min', s: 'sec', ms: 'ms' },
		exampleLines: [
			'1h 12m',
			'2d 04h',
			'06m 15s',
			'0d 00h 42m',
			'5m 08s',
			'3h 09m',
			'7m 45s',
			'12h 33m',
			'9s',
			'0h 00m 08s',
			'16m 02s',
			'23h 11m',
		],
	},
}

type FormatSnapshot = {
	uptimeStyle: UptimeStyle
	showMs: boolean
	timeUnit: TimeUnit
	separator: Separator
	padZeros: boolean
	minDigits: number
	labelStyle: LabelStyle
	prefix: string
	suffix: string
	uppercaseUnits: boolean
	template: string
	unitAliases: Record<string, string>
}

type ConfigSnapshot = FormatSnapshot & {
	refreshMs: number
	tickStep: number
	maxTicks: number
	autoPauseAtMax: boolean
}

type RuntimeSnapshot = {
	uptimeMs: number
	uptimeLabel: string
	ticks: number
	paused: boolean
}

type BuiltinState = {
	uptimeMs: number
	uptimeLabel: string
	ticks: number
	paused: boolean
	refreshMs: number
	tickStep: number
	maxTicks: number
}

const clampNumber = (input: unknown, fallback: number, min: number, max: number) => {
	const value = typeof input === 'number' ? input : Number(input)
	if (!Number.isFinite(value)) return fallback
	if (value < min) return min
	if (value > max) return max
	return value
}

const isUptimeStyle = (value: unknown): value is UptimeStyle =>
	UPTIME_STYLES.includes(value as UptimeStyle)

const isPicklistValue = <T extends readonly string[]>(values: T, value: unknown): value is T[number] =>
	typeof value === 'string' && (values as readonly string[]).includes(value)

const readBoolean = (value: unknown, fallback: boolean) =>
	typeof value === 'boolean' ? value : fallback

const readString = (value: unknown, fallback: string) =>
	typeof value === 'string' ? value : fallback

const toStringRecord = (value: unknown): Record<string, string> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	const out: Record<string, string> = {}
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === 'string') out[key] = item
	}
	return out
}

const UNIT_LABELS: Record<LabelStyle, Record<string, string>> = {
	short: { d: 'd', h: 'h', m: 'm', s: 's', ms: 'ms' },
	full: { d: 'day', h: 'hour', m: 'minute', s: 'second', ms: 'ms' },
	verbose: { d: 'days', h: 'hours', m: 'minutes', s: 'seconds', ms: 'milliseconds' },
}

const formatDuration = (ms: number, format: FormatSnapshot) => {
	const safeMs = Math.max(0, Math.floor(ms))
	const separator =
		format.separator === 'colon' ? ':' : format.separator === 'dot' ? '.' : ' '
	const labelTable = UNIT_LABELS[format.labelStyle]

	const formatValue = (value: number) => {
		if (!format.padZeros) return String(value)
		return String(value).padStart(format.minDigits, '0')
	}

	const resolveLabel = (unit: string) => {
		let label = format.unitAliases[unit] ?? labelTable[unit] ?? unit
		if (format.uppercaseUnits) label = label.toUpperCase()
		return label
	}

	const assemble = (value: number, unit: string) => {
		const numberText = formatValue(value)
		const unitText = resolveLabel(unit)
		const spacer = format.labelStyle === 'short' ? '' : ' '
		return `${numberText}${spacer}${unitText}`
	}

	const parts: Array<{ value: number; unit: string }> = []

	if (format.timeUnit === 'ms') {
		parts.push({ value: safeMs, unit: 'ms' })
	} else if (format.timeUnit === 's') {
		parts.push({ value: Math.floor(safeMs / 1000), unit: 's' })
	} else {
		const totalSeconds = Math.floor(safeMs / 1000)
		const seconds = totalSeconds % 60
		const totalMinutes = Math.floor(totalSeconds / 60)
		const minutes = totalMinutes % 60
		const totalHours = Math.floor(totalMinutes / 60)
		const hours = totalHours % 24
		const days = Math.floor(totalHours / 24)

		if (days) parts.push({ value: days, unit: 'd' })
		if (hours || parts.length) parts.push({ value: hours, unit: 'h' })
		if (minutes || parts.length) parts.push({ value: minutes, unit: 'm' })
		parts.push({ value: seconds, unit: 's' })
	}

	const trimmed =
		format.uptimeStyle === 'compact' ? parts.slice(0, Math.min(parts.length, 2)) : parts
	if (format.showMs && format.timeUnit === 'auto') {
		trimmed.push({ value: safeMs % 1000, unit: 'ms' })
	}

	const prefix = format.prefix ?? ''
	const suffix = format.suffix ?? ''
	const body = trimmed.map((part) => assemble(part.value, part.unit)).join(separator)
	const template = format.template?.trim()
	let templated = body
	if (template) {
		const tokenPattern = /{{\s*(uptime|value)\s*}}/g
		const hasToken = tokenPattern.test(template)
		templated = hasToken ? template.replace(tokenPattern, body).trim() : `${template} ${body}`.trim()
	}
	return `${prefix}${templated}${suffix}`
}

const DisplayConfig = v.object({
	refreshMs: v.pipe(
		v.optional(v.number(), DEFAULTS.display.refreshMs),
		f.formMeta({ label: '刷新间隔 (ms)', description: 'SSE state 推送间隔' }),
		f.numberMeta({ min: MIN_REFRESH_MS, max: MAX_REFRESH_MS, step: 250 }),
	),
})

const BehaviorConfig = v.object({
	tickStep: v.pipe(
		v.optional(v.number(), DEFAULTS.behavior.tickStep),
		f.formMeta({ label: 'Tick 步长', description: '每次 Tick 递增的数值' }),
		f.numberMeta({ min: 1, max: 100, step: 1 }),
	),
	maxTicks: v.pipe(
		v.optional(v.number(), DEFAULTS.behavior.maxTicks),
		f.formMeta({ label: 'Max ticks', description: '0 表示不限制' }),
		f.numberMeta({ min: 0, max: 1_000_000, step: 10 }),
	),
	autoPauseAtMax: v.pipe(
		v.optional(v.boolean(), DEFAULTS.behavior.autoPauseAtMax),
		f.formMeta({ label: '达到上限自动暂停', description: 'ticks >= Max 时自动暂停' }),
		f.booleanMeta({ variant: 'switch' }),
	),
})

const FormatConfig = v.object({
	uptimeStyle: v.pipe(
		v.optional(v.picklist(UPTIME_STYLES), DEFAULTS.format.uptimeStyle),
		f.formMeta({
			label: 'Uptime 样式',
			description: '显示时长的紧凑程度',
			section: SECTION_FORMAT,
		}),
		f.picklistMeta({
			variant: 'segmented',
			labels: { compact: '紧凑', full: '完整' },
		}),
	),
	showMs: v.pipe(
		v.optional(v.boolean(), DEFAULTS.format.showMs),
		f.formMeta({ label: '显示毫秒', description: 'Uptime 末尾追加 ms', section: SECTION_FORMAT }),
		f.booleanMeta({ variant: 'switch' }),
	),
	timeUnit: v.pipe(
		v.optional(v.picklist(TIME_UNITS), DEFAULTS.format.timeUnit),
		f.formMeta({ label: '单位策略', description: '用于视觉测试', section: SECTION_FORMAT }),
		f.picklistMeta({
			variant: 'segmented',
			labels: { auto: '自动', s: '秒', ms: '毫秒' },
		}),
	),
	separator: v.pipe(
		v.optional(v.picklist(SEPARATORS), DEFAULTS.format.separator),
		f.formMeta({ label: '分隔符', description: '用于视觉测试', section: SECTION_FORMAT }),
		f.picklistMeta({
			labels: { space: '空格', colon: '冒号', dot: '点号' },
		}),
	),
	padZeros: v.pipe(
		v.optional(v.boolean(), DEFAULTS.format.padZeros),
		f.formMeta({ label: '补零', description: '位数不足时补零', section: SECTION_FORMAT }),
		f.booleanMeta({ variant: 'switch' }),
	),
	minDigits: v.pipe(
		v.optional(v.number(), DEFAULTS.format.minDigits),
		f.formMeta({ label: '最小位数', description: '用于视觉测试', section: SECTION_FORMAT }),
		f.numberMeta({ min: 1, max: 6, step: 1 }),
	),
	labelStyle: v.pipe(
		v.optional(v.picklist(LABEL_STYLES), DEFAULTS.format.labelStyle),
		f.formMeta({ label: '文案风格', description: '用于视觉测试', section: SECTION_LABELS }),
		f.picklistMeta({
			variant: 'segmented',
			labels: { short: '简洁', full: '完整', verbose: '详细' },
		}),
	),
	prefix: v.pipe(
		v.optional(v.string(), DEFAULTS.format.prefix),
		f.formMeta({ label: '前缀', description: '显示前缀测试', section: SECTION_LABELS }),
		f.stringMeta({ placeholder: 'e.g. ~' }),
	),
	suffix: v.pipe(
		v.optional(v.string(), DEFAULTS.format.suffix),
		f.formMeta({ label: '后缀', description: '显示后缀测试', section: SECTION_LABELS }),
		f.stringMeta({ placeholder: 'e.g. approx' }),
	),
	uppercaseUnits: v.pipe(
		v.optional(v.boolean(), DEFAULTS.format.uppercaseUnits),
		f.formMeta({ label: '单位大写', description: '用于视觉测试', section: SECTION_LABELS }),
		f.booleanMeta({ variant: 'switch' }),
	),
	template: v.pipe(
		v.optional(v.string(), DEFAULTS.format.template),
		f.formMeta({
			label: '模板说明',
			description: '支持 {{uptime}} / {{value}} 占位符',
			section: SECTION_LABELS,
			layout: { fullWidth: true },
		}),
		f.stringMeta({
			mode: 'textarea',
			rows: 4,
			placeholder: '例：已运行 {{uptime}}，保持在线。',
		}),
	),
	unitAliases: v.pipe(
		v.optional(v.record(v.string(), v.string()), DEFAULTS.format.unitAliases),
		f.formMeta({
			label: '单位别名',
			description: '键值表测试',
			section: SECTION_ADVANCED,
			layout: { fullWidth: true },
		}),
		f.recordMeta({
			layout: 'list',
			addLabel: '添加别名',
			keyLabel: '原单位',
			valueLabel: '别名',
		}),
	),
	exampleLines: v.pipe(
		v.optional(v.array(v.string()), DEFAULTS.format.exampleLines),
		f.formMeta({
			label: '示例行',
			description: '列表字段测试',
			section: SECTION_ADVANCED,
			layout: { fullWidth: true },
		}),
		f.arrayMeta({ layout: 'list', addLabel: '添加示例', itemLabel: '内容' }),
	),
})

const RuntimeFormSchema = v.object({
	ticks: v.pipe(
		v.optional(v.number(), 0),
		f.formMeta({ label: 'ticks', description: '演示：AutoForm 手动提交 → RPC' }),
		f.numberMeta({ min: 0, max: 1_000_000, step: 1 }),
	),
})

const RuntimeToggleSchema = v.object({
	paused: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: 'paused', description: '演示：submitMode=onChange' }),
		f.booleanMeta({ variant: 'switch' }),
	),
})

@Plugin({ name: 'PluginBuiltinShowcase' })
export class PluginBuiltinShowcase extends BasePlugin {
	private startedAt = Date.now()
	private tickTimer: ReturnType<typeof setTimeout> | null = null
	private ticks = 0
	private paused = false

	@Config(DisplayConfig)
	private display!: Config<typeof DisplayConfig>
	@Config(BehaviorConfig)
	private behavior!: Config<typeof BehaviorConfig>
	@Config(FormatConfig)
	private format!: Config<typeof FormatConfig>
	@Config(RuntimeFormSchema)
	private _runtime!: Config<typeof RuntimeFormSchema>
	@Config(RuntimeToggleSchema)
	private _runtimeToggle!: Config<typeof RuntimeToggleSchema>

	override async init() {
		this.startedAt = Date.now()

		this.ctx.ext.rpc.registerExtension(() => new PluginBuiltinShowcaseRpc(this))

		this.registerBuiltins()
		this.ctx.ext.sse.registerExtension(() => this.pushState())
		this.startTickLoop()
	}

	private getConfigSnapshot(): ConfigSnapshot {
		// 这里优先展示“@Config 注入”的最常规用法：启动时注入一次，后续用字段即可。
		const display = (this.display ?? DEFAULTS.display) as Record<string, unknown>
		const behavior = (this.behavior ?? DEFAULTS.behavior) as Record<string, unknown>
		const format = (this.format ?? DEFAULTS.format) as Record<string, unknown>

		return {
			refreshMs: clampNumber(
				display.refreshMs,
				DEFAULTS.display.refreshMs,
				MIN_REFRESH_MS,
				MAX_REFRESH_MS,
			),
			tickStep: clampNumber(behavior.tickStep, DEFAULTS.behavior.tickStep, 1, 100),
			maxTicks: clampNumber(behavior.maxTicks, DEFAULTS.behavior.maxTicks, 0, 1_000_000),
			autoPauseAtMax: readBoolean(behavior.autoPauseAtMax, DEFAULTS.behavior.autoPauseAtMax),
			uptimeStyle: isUptimeStyle(format.uptimeStyle)
				? format.uptimeStyle
				: DEFAULTS.format.uptimeStyle,
			showMs: readBoolean(format.showMs, DEFAULTS.format.showMs),
			timeUnit: isPicklistValue(TIME_UNITS, format.timeUnit)
				? format.timeUnit
				: DEFAULTS.format.timeUnit,
			separator: isPicklistValue(SEPARATORS, format.separator)
				? format.separator
				: DEFAULTS.format.separator,
			padZeros: readBoolean(format.padZeros, DEFAULTS.format.padZeros),
			minDigits: clampNumber(format.minDigits, DEFAULTS.format.minDigits, 1, 6),
			labelStyle: isPicklistValue(LABEL_STYLES, format.labelStyle)
				? format.labelStyle
				: DEFAULTS.format.labelStyle,
			prefix: readString(format.prefix, DEFAULTS.format.prefix),
			suffix: readString(format.suffix, DEFAULTS.format.suffix),
			uppercaseUnits: readBoolean(format.uppercaseUnits, DEFAULTS.format.uppercaseUnits),
			template: readString(format.template, DEFAULTS.format.template),
			unitAliases:
				format.unitAliases && typeof format.unitAliases === 'object'
					? toStringRecord(format.unitAliases)
					: DEFAULTS.format.unitAliases,
		}
	}

	private getRuntimeSnapshot(config?: ConfigSnapshot): RuntimeSnapshot {
		const format = config ?? this.getConfigSnapshot()
		const uptimeMs = Date.now() - this.startedAt
		return {
			uptimeMs,
			uptimeLabel: formatDuration(uptimeMs, format),
			ticks: this.ticks,
			paused: this.paused,
		}
	}

	private buildState(): BuiltinState {
		const config = this.getConfigSnapshot()
		const runtime = this.getRuntimeSnapshot(config)

		return {
			uptimeMs: runtime.uptimeMs,
			uptimeLabel: runtime.uptimeLabel,
			ticks: runtime.ticks,
			paused: runtime.paused,
			refreshMs: config.refreshMs,
			tickStep: config.tickStep,
			maxTicks: config.maxTicks,
		}
	}

	private sse<T>(path: string, fallback: T) {
		return { kind: 'sse' as const, path, fallback }
	}

	private registerBuiltins() {
		this.registerOverviewDoc()
		this.registerTabDocs()
	}

	private registerOverviewDoc() {
		this.ctx.ext.ui.doc({
			id: 'summary',
			point: 'plugin:info',
			title: 'Builtin Overview',
			description: 'Host-rendered preset UI (no plugin UI module).',
			requireRunning: false,
			content: doc`
				${doc.block(
					'Overview',
					doc.card({
					layout: { variant: 'grid', density: 'compact', columns: 3, labelPlacement: 'top' },
					rows: [
						{ label: 'Plugin', value: this.ctx.pluginInfo.id },
						{ label: 'Uptime', value: this.sse('uptimeLabel', '0s') },
						{ label: 'Ticks', value: this.sse('ticks', 0) },
						{ label: 'Tick step', value: this.sse('tickStep', DEFAULTS.behavior.tickStep) },
						{ label: 'Paused', value: this.sse('paused', false) },
						{ label: 'Max ticks', value: this.sse('maxTicks', DEFAULTS.behavior.maxTicks) },
						{ label: 'Refresh (ms)', value: this.sse('refreshMs', DEFAULTS.display.refreshMs) },
					],
					}),
				)}
			`,
		})
	}

	private registerTabDocs() {
		const controlTab = { id: 'controls', label: 'Controls', icon: 'form' }
		const metricsTab = { id: 'metrics', label: 'Metrics', icon: 'activity' }
		const guideTab = { id: 'guide', label: 'Guide', icon: 'book' }

		this.ctx.ext.ui.doc({
			id: 'controls-doc',
			point: 'plugin:tabs',
			requireRunning: false,
			priority: 20,
			meta: { label: 'Controls', icon: 'form', tab: controlTab },
			content: doc`
				${doc.block(
					'Pause',
					doc.form({
					description: 'submitMode=onChange + SSE sync.',
					submitMode: 'onChange',
					autoSubmitDebounceMs: 120,
					syncFromSse: { kind: 'sse' },
					schemaKey: '_runtimeToggle',
					rpc: { method: 'setPaused', args: [{ kind: 'field', key: 'paused' }] },
					}),
				)}

				${doc.block(
					'Set ticks',
					doc.form({
					description: 'Manual submit → RPC.',
					submitLabel: 'Submit',
					submitMode: 'manual',
					schemaKey: '_runtime',
					rpc: { method: 'setTicks', args: [{ kind: 'field', key: 'ticks' }] },
					feedback: { success: { title: 'Submitted', tone: 'success' } },
					resetOnSuccess: false,
					}),
				)}
			`,
		})

		this.ctx.ext.ui.doc({
			id: 'metrics-doc',
			point: 'plugin:tabs',
			requireRunning: false,
			priority: 10,
			meta: { label: 'Metrics', icon: 'list', tab: metricsTab },
			content: doc`
				${doc.block(
					'Metrics Stream',
					doc.card({
					description: 'Compact status list (auto-updated).',
					layout: { variant: 'list', density: 'compact', valueAlign: 'right' },
					rows: this.buildMetricRows(),
					}),
				)}
			`,
		})

		const docContent = doc`
			# Builtin Doc
			基于 markdown 的内容区域，可以注入内置组件。

			${doc.block(
				'Snapshot',
				doc.card({
				description: 'Markdown + builtin blocks.',
				layout: { variant: 'grid', density: 'compact', columns: 3, labelPlacement: 'top' },
				rows: [
					{ label: 'Uptime', value: this.sse('uptimeLabel', '0s') },
					{ label: 'Ticks', value: this.sse('ticks', 0) },
					{ label: 'Paused', value: this.sse('paused', false) },
					{ label: 'Tick step', value: this.sse('tickStep', DEFAULTS.behavior.tickStep) },
					{ label: 'Refresh (ms)', value: this.sse('refreshMs', DEFAULTS.display.refreshMs) },
				],
				}),
			)}

			${doc.block(
				'Quick controls',
				doc.form({
				description: 'onChange + SSE sync.',
				submitMode: 'onChange',
				autoSubmitDebounceMs: 120,
				syncFromSse: { kind: 'sse' },
				schemaKey: '_runtimeToggle',
				rpc: { method: 'setPaused', args: [{ kind: 'field', key: 'paused' }] },
				}),
			)}

			- 纯文段和 builtin 表单可以混合排布
			- 适合在说明文档中加入可交互控件

			## 说明
			本段用于拉长文本，测试目录与滚动条联动效果。

			### 为什么选择 doc
			doc 让插件作者可以先写一段解释，再插入交互组件。
			同一页面里既能阅读，也能操作。

			### 使用建议
			- 段落要有结构
			- 章节层级不要太深
			- 关键点放在标题后几行

			### 视觉测试
			这里连续堆叠几段文本来制造滚动高度。
			在真实插件里可以用配置说明、故障排查步骤、变更记录等填充。

			#### 变更记录
			1. 新增内置 doc 渲染
			2. 支持 block 注入
			3. 支持 TOC

			#### 常见问题
			Q: 为什么要统一入口？
			A: 避免多套 UI 能力碎片化，降低维护成本。

			Q: 是否支持更复杂组件？
			A: 可以在 block 扩展里逐步加入。
		`

		this.ctx.ext.ui.doc({
			id: 'guide-doc',
			point: 'plugin:tabs',
			requireRunning: false,
			priority: 0,
			meta: { label: 'Guide', icon: 'book', tab: guideTab },
			content: docContent,
		})
	}

	private buildMetricRows() {
		const rows = [
			{
				label: 'Stream',
				value: { kind: 'badge', label: 'Live', color: 'green', variant: 'light' } as const,
			},
			{ label: 'Uptime', value: this.sse('uptimeLabel', '0s') },
			{ label: 'Uptime (ms)', value: this.sse('uptimeMs', 0) },
			{ label: 'Ticks', value: this.sse('ticks', 0) },
			{ label: 'Tick step', value: this.sse('tickStep', DEFAULTS.behavior.tickStep) },
			{ label: 'Paused', value: this.sse('paused', false) },
			{ label: 'Max ticks', value: this.sse('maxTicks', DEFAULTS.behavior.maxTicks) },
			{ label: 'Refresh (ms)', value: this.sse('refreshMs', DEFAULTS.display.refreshMs) },
			{
				label: 'Snapshot',
				value: this.sse('', {
					uptimeLabel: '0s',
					ticks: 0,
					refreshMs: DEFAULTS.display.refreshMs,
				}),
			},
		]

		return rows
	}

	private startTickLoop() {
		const tick = () => {
			const { refreshMs, tickStep, maxTicks, autoPauseAtMax } = this.getConfigSnapshot()
			if (!this.paused) {
				this.ticks += tickStep
				if (maxTicks > 0 && this.ticks >= maxTicks) {
					this.ticks = maxTicks
					if (autoPauseAtMax) this.paused = true
				}
			}
			this.tickTimer = setTimeout(tick, refreshMs)
		}
		tick()
		this.ctx.scope.collectEffect(() => {
			if (this.tickTimer) clearTimeout(this.tickTimer)
			this.tickTimer = null
		})
	}

	private pushState() {
		return (channel: SseChannel) => {
			let timer: ReturnType<typeof setTimeout> | null = null
			let aborted = false

			const emit = () => {
				channel.emit('state', this.buildState())
			}

			const schedule = () => {
				if (aborted) return
				const ms = this.getConfigSnapshot().refreshMs
				timer = setTimeout(() => {
					emit()
					schedule()
				}, ms)
			}

			emit()
			schedule()

			channel.onAbort(() => {
				aborted = true
				if (timer) clearTimeout(timer)
				timer = null
			})
			return () => {
				aborted = true
				if (timer) clearTimeout(timer)
				timer = null
			}
		}
	}

	setPaused(next: boolean) {
		this.paused = Boolean(next)
		return { ok: true, paused: this.paused }
	}

	setTicks(next: number) {
		const value = Number(next)
		if (!Number.isFinite(value) || value < 0) throw new Error('ticks must be a non-negative number')
		this.ticks = Math.floor(value)
		return { ok: true, ticks: this.ticks }
	}
}

export class PluginBuiltinShowcaseRpc extends RpcTarget {
	constructor(private readonly plugin: PluginBuiltinShowcase) {
		super()
	}

	setPaused(next: boolean) {
		return this.plugin.setPaused(next)
	}

	setTicks(next: number) {
		return this.plugin.setTicks(next)
	}
}

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			PluginBuiltinShowcase: PluginBuiltinShowcaseRpc
		}

		interface sse {
			PluginBuiltinShowcase: {
				uptimeMs: number
				uptimeLabel: string
				ticks: number
				paused: boolean
				refreshMs: number
				tickStep: number
				maxTicks: number
			}
		}
	}
}
