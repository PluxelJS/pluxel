import { AsyncLocalStorage } from 'node:async_hooks'
import { getConsoleSink, getJsonLinesFormatter, withFilter, type Config } from '@logtape/logtape'
import { logtape, type LogTapeConfig } from '@pluxel/core/config'
import type { CoreHostConfig } from '@pluxel/core'
import type { LoggingOptions, RuntimeLoggingInput } from '@pluxel/core/logging'

const native: Config<'output', 'minimum'> = {
	contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
	sinks: { output: getConsoleSink({ formatter: getJsonLinesFormatter() }) },
	filters: { minimum: 'debug' },
	loggers: [
		{
			category: ['application', 'database'],
			sinks: ['output'],
			filters: ['minimum'],
			parentSinks: 'forward',
			captureSourceLocation: true,
			lowestLevel: 'trace',
		},
	],
}
const options: LoggingOptions = {
	profile: 'production',
	debugTopics: ['cache:*'],
	policyLoadFailure: 'fail',
	initialPluginPolicy: { version: 3, defaultLevel: 'info', overrides: [] },
}
const bounded: RuntimeLoggingInput = ({ rootId, createRuntimeLogSink }) => ({
	sinks: { memory: withFilter(createRuntimeLogSink({ windowLines: 1000, caller: true }), 'info') },
	loggers: [{ category: ['pluxel', 'runtime', rootId], sinks: ['memory'], lowestLevel: 'trace' }],
})

export const nativeLoggingExamples = [
	logtape(),
	logtape(native, options),
	logtape(bounded),
] satisfies LogTapeConfig[]

export const coreConfiguration = { logger: logtape(native, options) } satisfies CoreHostConfig

logtape({
	sinks: {
		// @ts-expect-error Native sinks are functions; the removed kind/format DSL is not accepted.
		legacy: { kind: 'console', format: 'json' },
	},
	loggers: [],
})
