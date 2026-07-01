import { runtimePluginLogPolicy } from './policy'
import {
	createRuntimeLogging,
	type RuntimeConsoleSinkInput,
	type RuntimeLoggingPreset,
	type RuntimeUiSinkInput,
} from './logging'

export type EnsurePluxelLoggingOptions = {
	/**
	 * Log preset used by `@pluxel/core/logger`.
	 *
	 * Defaults to `hmr` because this helper is mainly for HMR hosts.
	 */
	preset?: RuntimeLoggingPreset
	/**
	 * Console sink:
	 * - `undefined` / `true`: enabled with preset defaults
	 * - `false`: disabled
	 */
	console?: boolean | RuntimeConsoleSinkInput
	/** File path used by the runtime helper (daily rotation by prefix path). */
	file?: string | false
	/**
	 * Enable the UI log-store sink (SSE/inspector UI).
	 *
	 * - `true` uses defaults (`minLevel=trace`, caller=true)
	 * - object forwards to `createRuntimeLogSink`
	 * - `false` disables it
	 */
	ui?: boolean | Exclude<RuntimeUiSinkInput, false>
	/**
	 * Debug topic patterns (e.g. `pluxel:hmr:*`).
	 *
	 * This controls the dedicated debug channel category `["pluxel","debug"]`.
	 */
	debug?: readonly string[]
}

function normalizeConsole(input: EnsurePluxelLoggingOptions['console']): RuntimeConsoleSinkInput {
	if (input === false) return false
	if (input === true || input === undefined) return { enabled: true }
	return input
}

function normalizeUi(input: EnsurePluxelLoggingOptions['ui']): RuntimeUiSinkInput {
	if (input === false) return false
	if (input === true || input === undefined)
		return { enabled: true, minLevel: 'trace', caller: true }
	return { caller: true, ...input }
}

/**
 * Ensure LogTape is configured for a Pluxel host app.
 *
 * @returns `true` if this call performed `configure()`, otherwise `false`.
 */
export async function ensurePluxelLogging(opts: EnsurePluxelLoggingOptions = {}): Promise<boolean> {
	const preset = opts.preset ?? 'hmr'
	const logging = createRuntimeLogging({
		preset,
		sinks: {
			console: normalizeConsole(opts.console),
			file: opts.file === false ? false : { enabled: true, path: opts.file ?? './logs/hmr.log' },
			ui: normalizeUi(opts.ui),
		},
		pluginPolicy: {
			policy: runtimePluginLogPolicy,
		},
		debugTopics: opts.debug,
	})

	return await logging.configure()
}
