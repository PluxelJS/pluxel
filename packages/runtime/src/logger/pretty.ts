import { getConsoleSink, type LogRecord, type Sink } from '@logtape/logtape'
import { getPrettyFormatter } from '@logtape/pretty'
import { readPluginLogIdentity } from '@pluxel/core/logger'
import { formatPrettyTimestamp, isReservedLogProperty } from './host'

export function createRuntimePrettyConsoleSink(options: {
	caller: boolean
	timezone: 'local' | 'utc'
}): Sink {
	const formatter = getPrettyFormatter({
		timestamp: (timestamp) => formatPrettyTimestamp(timestamp, options.timezone),
		timestampColor: null,
		timestampStyle: null,
		categoryStyle: null,
		messageStyle: null,
	})
	return getConsoleSink({
		formatter: (record) => {
			const caller = options.caller ? readCaller(record) : undefined
			const rendered = formatter({
				...record,
				category: displayCategory(record.category),
				properties: displayProperties(record.properties),
			})
			return caller ? `${rendered}  ⤷ ${caller}` : rendered
		},
	})
}

function displayCategory(category: readonly string[]): string[] {
	if (category[0] === 'pluxel' && category[1] === 'debug') {
		const topicStart = category[3] === 'plugin' ? 5 : 4
		return ['debug', category.slice(topicStart).join(':')]
	}
	const plugin = readPluginLogIdentity(category)
	if (plugin) return ['plugin', plugin.pluginId]
	if (category[0] === 'pluxel' && category[1] === 'runtime') return ['runtime']
	return [...category]
}

function displayProperties(properties: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(properties)) {
		if (!isReservedLogProperty(key)) out[key] = value
	}
	return out
}

function readCaller(record: LogRecord): string | undefined {
	return typeof record.properties.caller === 'string' ? record.properties.caller : undefined
}
