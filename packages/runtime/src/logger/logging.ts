import { mkdir } from 'node:fs/promises'
import {
	configure,
	getConfig,
	type Config,
	type LogLevel,
	type LogRecord,
	type Sink,
} from '@logtape/logtape'
import {
	captureCaller,
	createPluxelLogtapeConfig,
	type PluxelLogtapeConfigOptions,
} from '@pluxel/core/logger'
import { dirname } from 'pathe'
import { createDailyTimeRotatingFileSink } from './file'
import {
	RuntimePluginLogPolicy,
	readPluginLogPolicyFile,
	type PluginLogPolicySnapshot,
	type RuntimePluginLogLevel,
} from './policy'
import { createRuntimeLogSink, type RuntimeLogSinkOptions } from './sink'

export type RuntimeLoggingPreset = 'core' | 'hmr'
export type RuntimeLoggingSinkId = 'console' | 'file' | 'ui'

export type RuntimeConsoleSinkInput =
	| false
	| {
			enabled?: boolean
			format?: 'pretty'
			caller?: boolean
			youch?: boolean
	  }

export type RuntimeFileSinkInput =
	| false
	| {
			enabled?: boolean
			path: string
			format?: 'text'
			caller?: boolean
	  }

export type RuntimeUiSinkInput =
	| false
	| (Omit<RuntimeLogSinkOptions, 'caller'> & {
			enabled?: boolean
			caller?: boolean
	  })

export type RuntimeLoggingInput = {
	profile?: string
	preset?: RuntimeLoggingPreset
	minLevel?: LogLevel | null
	sinks?: {
		console?: RuntimeConsoleSinkInput
		file?: RuntimeFileSinkInput
		ui?: RuntimeUiSinkInput
	}
	pluginPolicy?: {
		path?: string
		defaultLevel?: RuntimePluginLogLevel
		overrides?: PluginLogPolicySnapshot['overrides']
		policy?: RuntimePluginLogPolicy
	}
	debugTopics?: readonly string[]
}

export type ResolvedConsoleSink = {
	enabled: true
	format: 'pretty'
	caller: boolean
	youch: boolean
}

export type ResolvedFileSink = {
	enabled: true
	path: string
	format: 'text'
	caller: boolean
}

export type ResolvedUiSink = Required<Pick<RuntimeLogSinkOptions, 'streamId'>> &
	Omit<RuntimeLogSinkOptions, 'caller'> & {
		enabled: true
		caller: boolean
	}

export type ResolvedRuntimeLoggingConfig = {
	profile: string
	preset: RuntimeLoggingPreset
	minLevel?: LogLevel | null
	sinks: {
		console?: ResolvedConsoleSink
		file?: ResolvedFileSink
		ui?: ResolvedUiSink
	}
	pluginPolicy: {
		path?: string
		initial: PluginLogPolicySnapshot
	}
	debugTopics: readonly string[]
}

export type RuntimeLoggingDescription = {
	resolved: ResolvedRuntimeLoggingConfig
	policy: PluginLogPolicySnapshot
	configured: boolean
}

export type RuntimeLogging = {
	readonly policy: RuntimePluginLogPolicy
	readonly resolved: ResolvedRuntimeLoggingConfig
	configure(): Promise<boolean>
	describe(): RuntimeLoggingDescription
	logtapeConfig(): Config<string, string>
}

const DEFAULT_PROFILE = 'default'

function resolvePolicyPath(path: string | undefined, profile: string): string | undefined {
	return path?.replaceAll('{profile}', profile)
}

function defaultCaller(preset: RuntimeLoggingPreset, sink: RuntimeLoggingSinkId): boolean {
	if (sink === 'file') return false
	if (sink === 'ui') return preset === 'hmr'
	return true
}

function resolveRuntimeLoggingConfig(
	input: RuntimeLoggingInput = {},
): ResolvedRuntimeLoggingConfig {
	const profile = input.profile ?? DEFAULT_PROFILE
	const preset = input.preset ?? 'hmr'
	const sinks = input.sinks ?? {}

	const consoleInput = sinks.console
	const consoleSink =
		consoleInput === false || consoleInput?.enabled === false
			? undefined
			: ({
					enabled: true,
					format: consoleInput?.format ?? 'pretty',
					caller: consoleInput?.caller ?? defaultCaller(preset, 'console'),
					youch: consoleInput?.youch ?? true,
				} satisfies ResolvedConsoleSink)

	const fileInput = sinks.file
	const fileSink =
		fileInput === false || fileInput?.enabled === false || !fileInput?.path
			? undefined
			: ({
					enabled: true,
					path: resolvePolicyPath(fileInput.path, profile) ?? fileInput.path,
					format: fileInput.format ?? 'text',
					caller: fileInput.caller ?? defaultCaller(preset, 'file'),
				} satisfies ResolvedFileSink)

	const uiInput = sinks.ui
	const uiSink =
		uiInput === false || uiInput?.enabled === false
			? undefined
			: ({
					...uiInput,
					enabled: true,
					streamId: uiInput?.streamId ?? 'default',
					caller: uiInput?.caller ?? defaultCaller(preset, 'ui'),
				} satisfies ResolvedUiSink)

	const defaultLevel = input.pluginPolicy?.defaultLevel
	const initial: PluginLogPolicySnapshot =
		defaultLevel === undefined
			? { overrides: input.pluginPolicy?.overrides ?? {} }
			: { defaultLevel, overrides: input.pluginPolicy?.overrides ?? {} }

	return {
		profile,
		preset,
		minLevel: input.minLevel,
		sinks: {
			console: consoleSink,
			file: fileSink,
			ui: uiSink,
		},
		pluginPolicy: {
			path: resolvePolicyPath(input.pluginPolicy?.path, profile),
			initial,
		},
		debugTopics: input.debugTopics ?? [],
	}
}

function withCaller(sink: Sink, enabled: boolean): Sink {
	if (!enabled) return sink
	const callers = new WeakMap<LogRecord, string | undefined>()
	const callerSink: Sink = (record) => {
		if (typeof record.properties.caller === 'string') {
			sink(record)
			return
		}

		let caller = callers.get(record)
		if (!callers.has(record)) {
			caller = captureCaller({ exclude: callerSink })
			callers.set(record, caller)
		}
		if (!caller) {
			sink(record)
			return
		}

		sink({
			...record,
			properties: { ...record.properties, caller },
		})
	}
	return callerSink
}

function createConsoleOptions(
	sink: ResolvedConsoleSink | undefined,
): PluxelLogtapeConfigOptions['console'] {
	if (!sink) return false
	return {
		pretty: { includeCaller: sink.caller },
		youch: sink.youch ? undefined : false,
	}
}

function createUiSink(sink: ResolvedUiSink | undefined): PluxelLogtapeConfigOptions['ui'] {
	if (!sink) return undefined
	const { enabled: _enabled, caller, ...options } = sink
	return {
		sink: createRuntimeLogSink({ ...options, caller }),
	}
}

function createFileSink(sink: ResolvedFileSink | undefined): PluxelLogtapeConfigOptions['file'] {
	if (!sink) return false
	return withCaller(createDailyTimeRotatingFileSink(sink.path), sink.caller)
}

export function createRuntimeLogging(input: RuntimeLoggingInput = {}): RuntimeLogging {
	const resolved = resolveRuntimeLoggingConfig(input)
	const policy =
		input.pluginPolicy?.policy ?? new RuntimePluginLogPolicy(resolved.pluginPolicy.initial)

	function logtapeConfig(): Config<string, string> {
		return createPluxelLogtapeConfig({
			preset: resolved.preset,
			lowestLevel: resolved.minLevel,
			console: createConsoleOptions(resolved.sinks.console),
			file: createFileSink(resolved.sinks.file),
			ui: createUiSink(resolved.sinks.ui),
			debug: resolved.debugTopics,
			pluginLevelLookup: policy.lookupLogtapeLevel,
		})
	}

	return {
		policy,
		resolved,
		logtapeConfig,
		describe() {
			return {
				resolved,
				policy: policy.snapshot(),
				configured: Boolean(getConfig()),
			}
		},
		async configure() {
			if (getConfig()) return false
			if (resolved.pluginPolicy.path) {
				const persisted = await readPluginLogPolicyFile(resolved.pluginPolicy.path)
				if (persisted) policy.replace(persisted)
			}
			if (resolved.sinks.file) await mkdir(dirname(resolved.sinks.file.path), { recursive: true })
			await configure(logtapeConfig())
			return true
		},
	}
}
