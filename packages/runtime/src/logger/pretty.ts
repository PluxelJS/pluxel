import { getConsoleSink, type LogRecord, type Sink } from '@logtape/logtape'
import { getPrettyFormatter } from '@logtape/pretty'
import { formatPluginNodeReference } from '@pluxel/core'
import { readPluginLogIdentity } from '@pluxel/core/logger'
import { formatPluginNodeStandaloneLabel } from '../runtime/plugin-label'
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
		categoryTruncate: false,
		messageStyle: null,
		properties: true,
	})
	return getConsoleSink({
		console: options.console,
		formatter: (record) => {
			const caller = options.caller ? readCaller(record) : undefined
			const rendered = formatter({
				...record,
				category: displayCategory(record),
				properties: displayProperties(record),
			})
			return caller ? `${rendered}  ⤷ ${caller}` : rendered
		},
	})
}

function displayCategory(record: LogRecord): string[] {
	const category = record.category
	if (category[0] === 'pluxel' && category[1] === 'debug') {
		const plugin = readPluginLogIdentity(category)
		const topicStart = plugin?.topicOffset ?? 4
		return plugin
			? [
					'plugin',
					displayPluginIdentity(record, plugin.node),
					'debug',
					category.slice(topicStart).join(':'),
				]
			: ['debug', category.slice(topicStart).join(':')]
	}
	const plugin = readPluginLogIdentity(category)
	if (plugin) return ['plugin', displayPluginIdentity(record, plugin.node)]
	if (category[0] === 'pluxel' && category[1] === 'runtime') return ['runtime']
	return [...category]
}

function displayPluginIdentity(
	record: LogRecord,
	nodeAddress: import('@pluxel/core').PluginNodeAddress,
): string {
	const displayName = record.properties.pluginDisplayName
	return typeof displayName === 'string'
		? formatPluginNodeStandaloneLabel(nodeAddress, displayName)
		: formatPluginNodeReference(nodeAddress)
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
