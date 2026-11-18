import { AsyncLocalStorage } from 'node:async_hooks'
import { getConsoleSink, getJsonLinesFormatter, withFilter, type Config } from '@logtape/logtape'
import type { CoreFacilitiesConfig, CoreHostConfig, RootContext } from '@pluxel/core'
import type { LogTapeConfig, LoggingOptions, RuntimeLoggingInput } from '@pluxel/core/logging'

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
	native,
	bounded,
	{ input: native, options },
	{},
	{ options },
] satisfies LogTapeConfig[]

export const coreFacilities = { logtape: { input: native, options } } satisfies CoreFacilitiesConfig
export const coreConfiguration = {
	...coreFacilities,
	execution: { startTimeoutMs: 20 },
} satisfies CoreHostConfig

export const nativeCoreConfiguration = { logtape: native } satisfies CoreHostConfig
export const factoryCoreConfiguration = { logtape: bounded } satisfies CoreHostConfig

export const legacyLogTape: Config<string, string> = {
	sinks: {
		// @ts-expect-error Native sinks are functions; the removed kind/format DSL is not accepted.
		legacy: { kind: 'console', format: 'json' },
	},
	loggers: [],
}

export function rootLoggingManagement(root: RootContext) {
	if (!root.logging) return
	root.logging.policy.setDefaultLevel('info')
	void root.logging.flush()
	// @ts-expect-error Only Core installs native logging.
	void root.logging.install()
	// @ts-expect-error Only Core supplies the policy persistence backend.
	void root.logging.initializePolicy()
	// @ts-expect-error Closing the root owns logging disposal.
	void root.logging.dispose()
	// @ts-expect-error Context identity binding is internal to Core.
	void root.logging.contextBinding
}
