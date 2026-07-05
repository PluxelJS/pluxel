import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { configureSync, resetSync } from '@logtape/logtape'
import { LoggerService } from '@pluxel/core/services'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createRuntimeLogging,
	runtimeLogStores,
	writePluginLogPolicyFile,
} from '@pluxel/runtime/logger'
import { withRuntimeContext } from '@pluxel/runtime/test'
import { createLoggerPluginContext } from '../support/logger-context'

async function emitPluginLog(pluginId: string, level: 'debug' | 'info', message: string) {
	return withRuntimeContext((root) => {
		const logger = new LoggerService(createLoggerPluginContext(root, pluginId))
		logger[level](message)
	})
}

describe('createRuntimeLogging', () => {
	let tmp: string | undefined

	afterEach(async () => {
		resetSync()
		if (tmp) await rm(tmp, { recursive: true, force: true })
		tmp = undefined
	})

	it('resolves explicit sinks and policy into inspectable config', () => {
		const logging = createRuntimeLogging({
			profile: 'plugins-host',
			preset: 'hmr',
			minLevel: 'debug',
			sinks: {
				console: { enabled: true, caller: true, youch: false },
				file: { enabled: true, path: './logs/runtime.log', caller: false },
				ui: { enabled: true, streamId: 'inspect', caller: true },
			},
			pluginPolicy: { defaultLevel: 'info', overrides: { PluginA: 'debug' } },
			debugTopics: ['pluxel:runtime:*'],
		})

		const description = logging.describe()
		expect(description.resolved.sinks.console?.caller).toBe(true)
		expect(description.resolved.sinks.file?.caller).toBe(false)
		expect(description.resolved.sinks.ui?.caller).toBe(true)
		expect(description.policy).toEqual({
			defaultLevel: 'info',
			overrides: { PluginA: 'debug' },
		})

		const config = logging.logtapeConfig()
		expect(config.sinks).toHaveProperty('console')
		expect(config.sinks).toHaveProperty('file')
		expect(config.sinks).toHaveProperty('ui')
		expect(config.filters).toHaveProperty('pluxelPluginLevels')
	})

	it('loads persisted policy before configuring LogTape', async () => {
		tmp = await mkdtemp(join(tmpdir(), 'pluxel-runtime-logging-'))
		const policyPath = join(tmp, 'logging-policy.json')
		const streamId = 'policy-configure'
		await writePluginLogPolicyFile(policyPath, {
			defaultLevel: 'warning',
			overrides: { PluginA: 'debug' },
		})

		const logging = createRuntimeLogging({
			preset: 'hmr',
			sinks: {
				console: false,
				file: false,
				ui: { enabled: true, streamId, bufferSize: 1, flushIntervalMs: 0, caller: false },
			},
			pluginPolicy: { path: policyPath, defaultLevel: 'info' },
		})

		await expect(logging.configure()).resolves.toBe(true)
		expect(logging.policy.snapshot()).toEqual({
			defaultLevel: 'warning',
			overrides: { PluginA: 'debug' },
		})

		await emitPluginLog('PluginA', 'debug', 'debug from A')
		await emitPluginLog('PluginB', 'info', 'info from B')

		const lines = runtimeLogStores.getOrCreate(streamId).tailWindow(10)
		expect(lines.map((line) => line.pluginId)).toEqual(['PluginA'])
	})

	it('does not reconfigure when LogTape is already configured', async () => {
		configureSync({
			sinks: { capture() {} },
			loggers: [{ category: ['pluxel'], sinks: ['capture'], lowestLevel: 'info' }],
		})

		const logging = createRuntimeLogging({ sinks: { console: false, file: false, ui: false } })
		await expect(logging.configure()).resolves.toBe(false)
	})
})
