import { f, v } from '@pluxel/runtime'

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

export const RUNTIME_DOC_ID = 'runtime' as const
export const RUNTIME_ACTIONS_COLLECTION = 'runtime-actions' as const

export const DEFAULTS = {
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

export type BuiltinState = {
	id: 'runtime'
	uptimeMs: number
	uptimeLabel: string
	ticks: number
	paused: boolean
	refreshMs: number
	tickStep: number
	maxTicks: number
}

export type BuiltinAction =
	| {
			id: string
			kind: 'setPaused'
			paused: boolean
			status: 'pending' | 'done' | 'error'
			createdAt?: number
			error?: string
	  }
	| {
			id: string
			kind: 'setTicks'
			ticks: number
			status: 'pending' | 'done' | 'error'
			createdAt?: number
			error?: string
	  }

type BuiltinFieldRef<Key extends string> = { kind: 'field'; key: Key }
export type BuiltinActionWrite =
	| { kind: 'setPaused'; paused: boolean | BuiltinFieldRef<'paused'> }
	| { kind: 'setTicks'; ticks: number | BuiltinFieldRef<'ticks'> }

export type BuiltinTabMeta = { id: string; label: string; icon: string }

const UNIT_LABELS: Record<LabelStyle, Record<string, string>> = {
	short: { d: 'd', h: 'h', m: 'm', s: 's', ms: 'ms' },
	full: { d: 'day', h: 'hour', m: 'minute', s: 'second', ms: 'ms' },
	verbose: { d: 'days', h: 'hours', m: 'minutes', s: 'seconds', ms: 'milliseconds' },
}

export function formatDuration(ms: number, format: FormatSnapshot) {
	const safeMs = Math.max(0, Math.floor(ms))
	const separator = format.separator === 'colon' ? ':' : format.separator === 'dot' ? '.' : ' '
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
		if (hours || parts.length > 0) parts.push({ value: hours, unit: 'h' })
		if (minutes || parts.length > 0) parts.push({ value: minutes, unit: 'm' })
		parts.push({ value: seconds, unit: 's' })
	}

	const trimmed =
		format.uptimeStyle === 'compact' ? parts.slice(0, Math.min(parts.length, 2)) : parts
	if (format.showMs && format.timeUnit === 'auto') {
		trimmed.push({ value: safeMs % 1000, unit: 'ms' })
	}

	const body = trimmed.map((part) => assemble(part.value, part.unit)).join(separator)
	const template = format.template.trim()
	const templated = template
		? /{{\s*(uptime|value)\s*}}/g.test(template)
			? template.replaceAll(/{{\s*(uptime|value)\s*}}/g, body).trim()
			: `${template} ${body}`.trim()
		: body
	return `${format.prefix}${templated}${format.suffix}`
}

export const DisplayConfig = v.object({
	refreshMs: v.pipe(
		v.optional(
			v.pipe(v.number(), v.minValue(MIN_REFRESH_MS), v.maxValue(MAX_REFRESH_MS)),
			DEFAULTS.display.refreshMs,
		),
		f.formMeta({ label: '刷新间隔 (ms)', description: 'signaldb 状态同步间隔' }),
		f.numberMeta({ min: MIN_REFRESH_MS, max: MAX_REFRESH_MS, step: 250 }),
	),
})

export const BehaviorConfig = v.object({
	tickStep: v.pipe(
		v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(100)), DEFAULTS.behavior.tickStep),
		f.formMeta({ label: 'Tick 步长', description: '每次 Tick 递增的数值' }),
		f.numberMeta({ min: 1, max: 100, step: 1 }),
	),
	maxTicks: v.pipe(
		v.optional(
			v.pipe(v.number(), v.minValue(0), v.maxValue(1_000_000)),
			DEFAULTS.behavior.maxTicks,
		),
		f.formMeta({ label: 'Max ticks', description: '0 表示不限制' }),
		f.numberMeta({ min: 0, max: 1_000_000, step: 10 }),
	),
	autoPauseAtMax: v.pipe(
		v.optional(v.boolean(), DEFAULTS.behavior.autoPauseAtMax),
		f.formMeta({ label: '达到上限自动暂停', description: 'ticks >= Max 时自动暂停' }),
		f.booleanMeta({}),
	),
})

export const FormatConfig = v.object({
	uptimeStyle: v.pipe(
		v.optional(v.picklist(UPTIME_STYLES), DEFAULTS.format.uptimeStyle),
		f.formMeta({
			label: 'Uptime 样式',
			description: '显示时长的紧凑程度',
			section: SECTION_FORMAT,
		}),
		f.picklistMeta({
			control: 'segmented',
			labels: { compact: '紧凑', full: '完整' },
		}),
	),
	showMs: v.pipe(
		v.optional(v.boolean(), DEFAULTS.format.showMs),
		f.formMeta({ label: '显示毫秒', description: 'Uptime 末尾追加 ms', section: SECTION_FORMAT }),
		f.booleanMeta({}),
	),
	timeUnit: v.pipe(
		v.optional(v.picklist(TIME_UNITS), DEFAULTS.format.timeUnit),
		f.formMeta({ label: '单位策略', description: '用于视觉测试', section: SECTION_FORMAT }),
		f.picklistMeta({
			control: 'segmented',
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
		f.booleanMeta({}),
	),
	minDigits: v.pipe(
		v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(6)), DEFAULTS.format.minDigits),
		f.formMeta({ label: '最小位数', description: '用于视觉测试', section: SECTION_FORMAT }),
		f.numberMeta({ min: 1, max: 6, step: 1 }),
	),
	labelStyle: v.pipe(
		v.optional(v.picklist(LABEL_STYLES), DEFAULTS.format.labelStyle),
		f.formMeta({ label: '文案风格', description: '用于视觉测试', section: SECTION_LABELS }),
		f.picklistMeta({
			control: 'segmented',
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
		f.booleanMeta({}),
	),
	template: v.pipe(
		v.optional(v.string(), DEFAULTS.format.template),
		f.formMeta({
			label: '模板说明',
			description: '支持 {{uptime}} / {{value}} 占位符',
			section: SECTION_LABELS,
			layout: { full: true },
		}),
		f.stringMeta({
			control: 'textarea',
			rows: 4,
			placeholder: '例：已运行 {{uptime}}，保持在线。',
		}),
	),
	unitAliases: v.pipe(
		v.optional(v.record(v.string(), v.string()), DEFAULTS.format.unitAliases),
		f.formMeta({
			label: '单位别名',
			description: '覆盖默认单位文案',
			section: SECTION_LABELS,
			layout: { full: true },
		}),
		f.recordMeta({
			layout: 'list',
			addLabel: '添加别名',
			key: { label: '原单位' },
			value: { label: '别名' },
		}),
	),
})

export const RuntimeFormSchema = v.object({
	ticks: v.pipe(
		v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1_000_000)), 0),
		f.formMeta({ label: 'ticks', description: '演示：AutoForm 手动提交 → signaldb action' }),
		f.numberMeta({ min: 0, max: 1_000_000, step: 1 }),
	),
})

export const RuntimeToggleSchema = v.object({
	paused: v.pipe(
		v.optional(v.boolean(), false),
		f.formMeta({ label: 'paused', description: '演示：submitMode=onChange + signaldb action' }),
		f.booleanMeta({}),
	),
})
