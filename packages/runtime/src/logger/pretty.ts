import { getConsoleSink, type LogRecord, type Sink } from '@logtape/logtape'
import { getPrettyFormatter } from '@logtape/pretty'
import { formatPluginNodeAddress } from '@pluxel/core'
import { readPluginLogIdentity } from '@pluxel/core/logger'
import { formatPrettyTimestamp, isReservedLogProperty } from './host'
import { toPlainObject } from './serialization'

export function createRuntimePrettyConsoleSink(options: {
	caller: boolean
	timezone: 'local' | 'utc'
	console?: Console
}): Sink {
	const formatter = getPrettyFormatter({
		timestamp: (timestamp) => formatPrettyTimestamp(timestamp, options.timezone),
		timestampColor: null,
		timestampStyle: null,
		categoryStyle: null,
		messageStyle: null,
		properties: true,
	})
	return getConsoleSink({
		console: options.console,
		formatter: (record) => {
			const caller = options.caller ? readCaller(record) : undefined
			const rendered = formatter({
				...record,
				category: displayCategory(record.category),
				properties: displayProperties(record),
			})
			return caller ? `${rendered}  ⤷ ${caller}` : rendered
		},
	})
}

function displayCategory(category: readonly string[]): string[] {
	if (category[0] === 'pluxel' && category[1] === 'debug') {
		const topicStart = readPluginLogIdentity(category)?.topicOffset ?? 4
		return ['debug', category.slice(topicStart).join(':')]
	}
	const plugin = readPluginLogIdentity(category)
	if (plugin) return ['plugin', formatPluginNodeAddress(plugin.node)]
	if (category[0] === 'pluxel' && category[1] === 'runtime') return ['runtime']
	return [...category]
}

function displayProperties(record: LogRecord): Record<string, unknown> {
	if (!isDiagnosticLevel(record.level)) return {}
	const out: Record<string, unknown> = {}
	const seen = new WeakSet<object>()
	for (const [key, value] of Object.entries(record.properties)) {
		if (!isReservedLogProperty(key)) out[key] = toPlainObject(value, 6, seen)
	}
	return out
}

function isDiagnosticLevel(level: LogRecord['level']): boolean {
	return level === 'warning' || level === 'error' || level === 'fatal'
}

function readCaller(record: LogRecord): string | undefined {
	return typeof record.properties.caller === 'string' ? record.properties.caller : undefined
}
