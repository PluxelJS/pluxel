import { mkdir } from 'node:fs/promises'
import { configure, getConfig } from '@logtape/logtape'
import {
	createPluxelLogtapeConfig,
	createPluxelPluginLevelState,
	type PluxelLogtapeConfigOptions,
} from '@pluxel/core/logger'
import { dirname } from 'pathe'

import { createRuntimeLogSink, type RuntimeLogSinkOptions } from './sink'

/**
 * Mutable per-plugin level map for HMR hosts.
 *
 * This is a convenience: hosts (or UI) can tweak levels at runtime without
 * re-running `configure()`, because the LogTape filter reads this state per record.
 */
export const hmrPluginLevels = createPluxelPluginLevelState()

export type EnsurePluxelLoggingOptions = {
	/**
	 * Log preset used by `@pluxel/core/logger`.
	 *
	 * Defaults to `hmr` because this helper is mainly for HMR hosts.
	 */
	preset?: 'hmr' | 'core'
	/**
	 * Console sink:
	 * - `undefined` / `true`: enabled with preset defaults
	 * - `false`: disabled
	 */
	console?: PluxelLogtapeConfigOptions['console']
	/** File path passed to `createPluxelLogtapeConfig({ file })`. */
	file?: string | false
	/**
	 * Enable the UI log-store sink (SSE/inspector UI).
	 *
	 * - `true` uses defaults (`minLevel=trace`)
	 * - object forwards to `createRuntimeLogSink`
	 * - `false` disables it
	 */
	ui?: boolean | RuntimeLogSinkOptions
	/**
	 * Debug topic patterns (e.g. `pluxel:hmr:*`).
	 *
	 * This controls the dedicated debug channel category `["pluxel","debug"]`.
	 */
	debug?: readonly string[]
}

/**
 * Ensure LogTape is configured for a Pluxel host app.
 *
 * Downstream can call this without importing `@logtape/logtape` directly.
 * This keeps "host entry" code simple while still making logging explicit.
 *
 * @returns `true` if this call performed `configure()`, otherwise `false`.
 */
export async function ensurePluxelLogging(opts: EnsurePluxelLoggingOptions = {}): Promise<boolean> {
	if (getConfig()) return false

	const preset = opts.preset ?? 'hmr'
	const file = opts.file ?? './logs/hmr.log'
	if (typeof file === 'string') {
		await mkdir(dirname(file), { recursive: true })
	}

	const ui =
		opts.ui === false
			? undefined
			: createRuntimeLogSink(typeof opts.ui === 'object' ? { ...opts.ui } : { minLevel: 'trace' })

	await configure(
		createPluxelLogtapeConfig({
			preset,
			console: opts.console,
			file,
			ui: ui ? { sink: ui } : undefined,
			debug: opts.debug,
			pluginLevels: hmrPluginLevels.lookup,
		}),
	)

	return true
}
