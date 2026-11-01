import { AsyncLocalStorage } from 'node:async_hooks'
import { getConfig, type Config, type LogRecord } from '@logtape/logtape'
import { describe, expect, it } from 'vitest'
import { logtape } from '@pluxel/core/config'
import { resolveLogTapeConfig } from '../../src/config/logtape'
import type {
	LoggingOptions,
	PluginLogPolicySnapshot,
	RuntimeLoggingInput,
} from '@pluxel/core/logging'

describe('Core native LogTape declarations', () => {
	it('does not evaluate factories, policy stores or native resources while declaring or resolving', () => {
		let configFactories = 0
		let policyFactories = 0
		let records = 0
		let disposals = 0
		const sink = Object.assign((_record: LogRecord) => records++, {
			[Symbol.dispose]() {
				disposals++
			},
		})
		const input: RuntimeLoggingInput = () => {
			configFactories++
			return { sinks: { native: sink }, loggers: [] }
		}
		const declaration = logtape(input, {
			policyStore() {
				policyFactories++
				throw new Error('policy factory must wait for preparation')
			},
		})
		expect(resolveLogTapeConfig(declaration)).toBe(declaration)
		expect(declaration.input).toBe(input)
		expect(declaration.options.profile).toBe('pluxel')
		expect([configFactories, policyFactories, records, disposals]).toEqual([0, 0, 0, 0])
		expect(getConfig()).toBeNull()
	})

	it('snapshots native routing containers and policy input while retaining resource identities', () => {
		const storage = new AsyncLocalStorage<Record<string, unknown>>()
		const sink = (_record: LogRecord): void => undefined
		const filter = (_record: LogRecord) => true
		const input: Config<string, string> = {
			contextLocalStorage: storage,
			sinks: { native: sink },
			filters: { native: filter },
			loggers: [
				{
					category: ['application'],
					sinks: ['native'],
					filters: ['native'],
					parentSinks: 'forward',
				},
			],
		}
		const initialPluginPolicy: PluginLogPolicySnapshot = {
			version: 3,
			defaultLevel: 'debug',
			overrides: [],
		}
		const options: LoggingOptions = {
			debugTopics: ['hmr:*'],
			profile: 'production',
			initialPluginPolicy,
		}
		const declaration = logtape(input, options)
		input.sinks.native = (): void => undefined
		input.filters!.native = 'fatal'
		input.loggers[0]!.sinks!.push('later')
		;(input.loggers[0]!.category as string[]).push('later')
		input.loggers.push({ category: 'later' })
		;(options.debugTopics as string[]).push('later')
		initialPluginPolicy.defaultLevel = 'fatal'
		const snapshot = declaration.input as Config<string, string>
		expect(snapshot.sinks.native).toBe(sink)
		expect(snapshot.filters?.native).toBe(filter)
		expect(snapshot.contextLocalStorage).toBe(storage)
		expect(snapshot.loggers).toEqual([
			{ category: ['application'], sinks: ['native'], filters: ['native'], parentSinks: 'forward' },
		])
		expect(declaration.options.debugTopics).toEqual(['hmr:*'])
		expect(declaration.options.profile).toBe('production')
		expect(declaration.options.initialPluginPolicy?.defaultLevel).toBe('debug')
		expect(Object.isFrozen(declaration)).toBe(true)
		expect(Object.isFrozen(snapshot.loggers)).toBe(true)
		expect(Object.isFrozen(snapshot.sinks)).toBe(true)
		expect(Object.isFrozen(sink)).toBe(false)
		expect(Object.isFrozen(filter)).toBe(false)
		expect(Object.isFrozen(storage)).toBe(false)
		expect(getConfig()).toBeNull()
	})

	it('rejects undeclared logger objects, native takeover and malformed independent options', () => {
		expect(resolveLogTapeConfig(undefined)).toBeUndefined()
		expect(() => resolveLogTapeConfig({ rootId: 'old-input' } as never)).toThrow(
			'declared with logtape()',
		)
		expect(() => logtape({ sinks: {}, loggers: [], reset: true })).toThrow(
			'reset:true is not allowed',
		)
		const invalidOptions: unknown[] = [
			null,
			false,
			42,
			'',
			[],
			{ profile: null },
			{ policyStore: true },
		]
		for (const options of invalidOptions)
			expect(() => logtape({ sinks: {}, loggers: [] }, options as never)).toThrow('[core.logtape]')
		expect(getConfig()).toBeNull()
	})
})
