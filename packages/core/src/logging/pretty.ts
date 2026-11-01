import { getConsoleSink, type ConsoleSinkOptions, type LogRecord } from '@logtape/logtape'
import { getPrettyFormatter, type PrettyFormatterOptions } from '@logtape/pretty'
import { formatPluginNodeReference, type PluginNodeAddress } from '../plugins/runtime/identity'
import { formatPluginNodeStandaloneLabel } from '../plugins/runtime/plugin-label'
import { readPluginLogIdentity } from '../logger/categories'
import { formatPrettyTimestamp, isReservedLogProperty } from './host'
import { toPlainObject } from './serialization'

export type RuntimePrettyConsoleSinkOptions = ConsoleSinkOptions & {
	/** Native options override the optional preset's formatter defaults. */
	pretty?: PrettyFormatterOptions
	caller?: boolean
	timezone?: 'local' | 'utc'
}

/** Project Pluxel identities, retaining native console options and formatter results. */
export function createRuntimePrettyConsoleSink(
	options: RuntimePrettyConsoleSinkOptions = {},
): ReturnType<typeof getConsoleSink> {
	const { pretty, caller = false, timezone = 'local', ...consoleOptions } = options
	const nativeProperties =
		pretty?.properties !== undefined || consoleOptions.formatter !== undefined
	const formatter =
		consoleOptions.formatter ??
		getPrettyFormatter({
			timestamp: (timestamp) => formatPrettyTimestamp(timestamp, timezone),
			timestampColor: null,
			timestampStyle: null,
			categoryStyle: null,
			categoryTruncate: false,
			messageStyle: null,
			properties: true,
			...pretty,
		})
	return getConsoleSink({
		...consoleOptions,
		formatter: (record) => {
			const source = caller ? readCaller(record) : undefined
			const rendered = formatter({
				...record,
				category: displayCategory(record),
				properties: displayProperties(record, nativeProperties),
			})
			if (typeof rendered === 'string')
				return [(source ? `${rendered}  ⤷ ${source}` : rendered).replace(/\r?\n$/, '')]
			return source ? [...rendered, `⤷ ${source}`] : rendered
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

function displayPluginIdentity(record: LogRecord, nodeAddress: PluginNodeAddress): string {
	const displayName = record.properties.pluginDisplayName
	return typeof displayName === 'string'
		? formatPluginNodeStandaloneLabel(nodeAddress, displayName)
		: formatPluginNodeReference(nodeAddress)
}

function displayProperties(record: LogRecord, native: boolean): Record<string, unknown> {
	if (!native && !isDiagnosticLevel(record.level)) return {}
	const out: Record<string, unknown> = {}
	const seen = new WeakSet<object>()
	for (const [key, value] of Object.entries(record.properties)) {
		if (!isReservedLogProperty(key)) out[key] = native ? value : toPlainObject(value, 6, seen)
	}
	return out
}

function isDiagnosticLevel(level: LogRecord['level']): boolean {
	return level === 'warning' || level === 'error' || level === 'fatal'
}

function readCaller(record: LogRecord): string | undefined {
	return typeof record.properties.caller === 'string' ? record.properties.caller : undefined
}
