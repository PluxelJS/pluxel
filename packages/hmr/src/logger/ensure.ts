import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { configure, getConfig } from '@logtape/logtape'
import { createPluxelLogtapeConfig } from '@pluxel/core/logger'

import { createLogStoreSink } from './sinks'

export type EnsurePluxelLoggingOptions = {
	/**
	 * Log preset used by `@pluxel/core/logger`.
	 *
	 * Defaults to `hmr` because this helper is mainly for HMR hosts.
	 */
	preset?: 'hmr' | 'core'
	/** File path passed to `createPluxelLogtapeConfig({ file })`. */
	file?: string | false
	/**
	 * Enable the UI log-store sink (SSE/inspector UI).
	 *
	 * - `true` uses defaults (`minLevel=trace`)
	 * - object forwards to `createLogStoreSink`
	 * - `false` disables it
	 */
	ui?: boolean | { minLevel?: string; includeCaller?: boolean }
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
			: createLogStoreSink(
					typeof opts.ui === 'object' ? { ...opts.ui } : { minLevel: 'trace' },
				)

	await configure(
		createPluxelLogtapeConfig({
			preset,
			file,
			ui: ui ? { sink: ui } : undefined,
			debug: opts.debug,
		}),
	)

	return true
}

