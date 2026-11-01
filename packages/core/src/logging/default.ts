import { getConsoleSink, withFilter, type Config } from '@logtape/logtape'
import type { RuntimeLoggingSetup } from './logging'

/** The optional application preset; custom configurations replace it completely. */
export function defaultLoggingConfig({
	createRuntimeLogSink,
}: RuntimeLoggingSetup): Config<string, string> {
	return {
		sinks: {
			console: withFilter(getConsoleSink(), 'info'),
			store: createRuntimeLogSink({ caller: true }),
		},
		loggers: [
			{ category: ['pluxel'], sinks: ['console', 'store'], lowestLevel: 'trace' },
			{
				category: ['pluxel', 'debug'],
				sinks: ['store'],
				parentSinks: 'override',
				lowestLevel: 'trace',
			},
			{ category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
		],
	}
}
