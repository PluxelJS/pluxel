import { configureSync, getConfig, reset } from '@logtape/logtape'
import { LoggerService } from '@pluxel/core/services'
import {
	createRuntimeLogging,
	type RuntimeLogging,
	type RuntimeLoggingInput,
} from '@pluxel/runtime/internal'
import { afterEach, describe, expect, it } from 'vitest'

function storePlan(initialPluginPolicy?: RuntimeLoggingInput['root']['initialPluginPolicy']) {
	return {
		root: {
			profile: 'test',
			initialPluginPolicy,
			debugTopics: ['hmr:*'],
		},
		sinks: {
			store: {
				kind: 'store',
				streamId: 'default',
				bufferSize: 1,
				flushIntervalMs: 0,
				caller: true,
			},
		},
		routes: {
			runtime: [{ sink: 'store', minLevel: 'trace' }],
			plugins: [{ sink: 'store', minLevel: 'trace' }],
			debug: [{ sink: 'store', minLevel: 'trace' }],
			meta: [],
		},
	} satisfies RuntimeLoggingInput
}

function pluginLogger(logging: RuntimeLogging, pluginId: string) {
	return new LoggerService(
		{ name: pluginId, pluginInfo: { id: pluginId } } as never,
		logging.contextBinding,
	)
}

describe('RuntimeLogging', () => {
	let logging: RuntimeLogging | undefined

	afterEach(async () => {
		await logging?.dispose()
		logging = undefined
		if (getConfig()) await reset()
	})

	it('resolves an inspectable root plan without per-plugin logger config', () => {
		logging = createRuntimeLogging(
			storePlan({ version: 1, defaultLevel: 'info', overrides: { PluginA: 'debug' } }),
		)
		const description = logging.describe()
		expect(description.state).toBe('created')
		expect(description.plan.root.id).toBeTruthy()
		expect(description.plan.routes.plugins).toEqual([{ sink: 'store', minLevel: 'trace' }])
		expect(description.root.policy).toMatchObject({
			version: 1,
			defaultLevel: 'info',
			overrides: { PluginA: 'debug' },
		})
	})

	it('changes one plugin level without reconfiguring LogTape', async () => {
		logging = createRuntimeLogging(storePlan())
		await logging.install()
		await logging.initializePolicy()
		const config = getConfig()
		const logger = pluginLogger(logging, 'PluginA')

		logger.debug('rejected')
		logging.policy.setPluginLevel('PluginA', 'debug')
		logger.debug('accepted')

		expect(getConfig()).toBe(config)
		expect(
			logging.stores
				.getOrCreate('default')
				.tailWindow(10)
				.map((line) => ({ message: line.msg, pluginId: line.pluginId })),
		).toEqual([{ message: 'accepted', pluginId: 'PluginA' }])
	})

	it('intersects plugin policy with the root debug topic matcher', async () => {
		logging = createRuntimeLogging(storePlan())
		await logging.install()
		await logging.initializePolicy()
		const logger = pluginLogger(logging, 'PluginA')

		logger.getDebugChannel('hmr:cache').debug('policy rejected')
		logging.policy.setPluginLevel('PluginA', 'debug')
		logger.getDebugChannel('other:cache').debug('topic rejected')
		logger.getDebugChannel('hmr:cache').debug('accepted')

		expect(
			logging.stores
				.getOrCreate('default')
				.tailWindow(10)
				.map((line) => ({ message: line.msg, pluginId: line.pluginId })),
		).toEqual([{ message: 'accepted', pluginId: 'PluginA' }])
	})

	it('fails closed for records bound to another root', async () => {
		logging = createRuntimeLogging(storePlan())
		await logging.install()
		await logging.initializePolicy()
		const foreign = new LoggerService({ name: 'PluginA', pluginInfo: { id: 'PluginA' } } as never, {
			rootId: 'foreign-root',
		})

		foreign.info('foreign')
		expect(logging.stores.getOrCreate('default').tailWindow(10)).toHaveLength(0)
		expect(logging.describe().diagnostics.wrongRootRecords).toBe(1)
	})

	it('rejects installation when LogTape has a foreign owner', async () => {
		configureSync({ sinks: {}, loggers: [] })
		logging = createRuntimeLogging(storePlan())
		await expect(logging.install()).rejects.toThrow('foreign owner')
	})

	it('bounds compiled debug topic patterns', () => {
		expect(() =>
			createRuntimeLogging({
				...storePlan(),
				root: { profile: 'test', debugTopics: ['x'.repeat(81)] },
			}),
		).toThrow('Invalid debug topic pattern')
	})

	it('releases the LogTape process exit hook when disposed', async () => {
		const before = process.listenerCount('exit')
		for (let index = 0; index < 12; index++) {
			logging = createRuntimeLogging(storePlan())
			await logging.install()
			await logging.dispose()
			logging = undefined
		}
		expect(process.listenerCount('exit')).toBe(before)
	})
})
