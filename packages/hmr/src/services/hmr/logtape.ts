import { mkdir } from 'node:fs/promises'

import { configure, getConfig, type LogLevel } from '@logtape/logtape'
import type { Context } from '@pluxel/core'
import { createPluxelLogtapeConfig } from '@pluxel/core/logger'
import { dirname } from 'pathe'

import { createLogStoreSink } from '../../logger/sinks'

export type HmrAutoLogtapeConfig = {
	enabled: boolean
	file: string | false
	ui: boolean
	uiMinLevel: LogLevel
	debug?: readonly Context.DebugTopicPattern[]
}

let ensured: Promise<void> | null = null

export function ensureHmrLogtapeConfigured(opts: HmrAutoLogtapeConfig): Promise<void> {
	if (getConfig()) return Promise.resolve()
	if (ensured) return ensured

	ensured = (async () => {
		if (getConfig()) return
		if (!opts.enabled) return

		if (opts.file) {
			try {
				await mkdir(dirname(opts.file), { recursive: true })
			} catch {
				// ignore mkdir failure; file sink may still work (or the host disables it)
			}
		}

		const config = createPluxelLogtapeConfig({
			preset: 'hmr',
			file: opts.file,
			ui: opts.ui ? createLogStoreSink({ minLevel: opts.uiMinLevel }) : false,
			debug: opts.debug,
		})

		await configure(config)
	})()

	return ensured
}
