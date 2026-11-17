import type { LogRecord } from '@logtape/logtape'
import { debugLogCategory, pluginLogCategory } from '@pluxel/core/logger'
import { describe, expect, it } from 'vitest'
import { createRuntimePrettyConsoleSink } from '@pluxel/core/logging/pretty'
import { logtape } from '@pluxel/core/config'
import { createHost } from '@pluxel/host'

const plugin = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/orders' },
		exportName: 'OrdersPlugin',
	},
	variant: 'default',
} as const

function record(
	level: LogRecord['level'],
	properties: LogRecord['properties'],
	category: readonly string[] = pluginLogCategory('test-root', plugin),
): LogRecord {
	return {
		category,
		level,
		message: ['plugin event'],
		rawMessage: 'plugin event',
		timestamp: Date.UTC(2026, 0, 1),
		properties,
	}
}

describe('runtime pretty console sink', () => {
	it('honors native pretty options for routine properties, timestamps and level formatting', () => {
		const lines: string[] = []
		const sink = createRuntimePrettyConsoleSink({
			console: captureConsole(lines),
			pretty: {
				timestamp: () => 'NATIVE_TIME',
				level: () => 'NATIVE_LEVEL',
				properties: true,
				colors: false,
				icons: false,
				wordWrap: false,
			},
		})
		sink(record('info', { operation: 'native-visible' }))
		const output = lines.join('')
		expect(output).toContain('NATIVE_TIME')
		expect(output).toContain('NATIVE_LEVEL')
		expect(output).toContain('native-visible')
		expect(output).toContain('package:@test/orders::OrdersPlugin')
	})

	it('retains native console formatter arguments, property values and level mapping', () => {
		const calls: unknown[][] = []
		const nativeConsole = captureConsole([])
		nativeConsole.warn = (...args: unknown[]) => {
			calls.push(args)
		}
		const payload = new Map([['native', 42]])
		let received: LogRecord | undefined
		const sink = createRuntimePrettyConsoleSink({
			console: nativeConsole,
			levelMap: {
				trace: 'debug',
				debug: 'debug',
				info: 'warn',
				warning: 'warn',
				error: 'error',
				fatal: 'error',
			},
			formatter: (entry) => {
				received = entry
				return ['native %s', entry.properties.payload]
			},
		})
		sink(record('info', { payload }))
		expect(received?.properties.payload).toBe(payload)
		expect(received?.category).toEqual(['plugin', 'package:@test/orders::OrdersPlugin'])
		expect(calls).toEqual([['native %s', payload]])
	})

	it('drains native non-blocking console output and retains text formatter newline behavior', async () => {
		const lines: string[] = []
		const sink = createRuntimePrettyConsoleSink({
			console: captureConsole(lines),
			formatter: (entry) => `native ${entry.message.join('')}\n`,
			nonBlocking: { bufferSize: 100, flushInterval: 60_000 },
		})
		const host = await createHost({
			plugins: [],
			services: [],
			runtime: {
				logtape: logtape({
					sinks: { native: sink },
					loggers: [{ category: ['pluxel', 'runtime'], sinks: ['native'] }],
				}),
			},
		})
		try {
			host.ctx.logger.info('buffered until drain')
			expect(lines).toEqual([])
		} finally {
			await host.close()
		}
		expect(lines).toEqual(['native buffered until drain'])
	})

	it('keeps routine structured properties compact', () => {
		const lines: string[] = []
		const sink = createRuntimePrettyConsoleSink({
			caller: false,
			timezone: 'utc',
			console: captureConsole(lines),
		})

		sink(record('info', { operation: 'startup' }))

		const output = lines.join('')
		expect(output).toContain('plugin event')
		expect(output).toContain('package:@test/orders::OrdersPlugin')
		expect(output).not.toContain('operation')
	})

	it('renders a readable plugin label and diagnostics without reserved identity properties', () => {
		const lines: string[] = []
		const sink = createRuntimePrettyConsoleSink({
			caller: false,
			timezone: 'utc',
			console: captureConsole(lines),
		})
		const error = new Error('visible root cause')

		sink(
			record('error', {
				context: 'hidden-context',
				pluginDisplayName: 'Orders',
				error,
				attempt: 2,
			}),
		)

		const output = lines.join('')
		expect(output).toContain('Orders (@test/orders::OrdersPlugin)')
		expect(output).toContain('visible root cause')
		expect(output).toContain('attempt')
		expect(output).not.toContain('hidden-context')
	})

	it('keeps plugin identity visible on debug channels', () => {
		const lines: string[] = []
		const sink = createRuntimePrettyConsoleSink({
			caller: false,
			timezone: 'utc',
			console: captureConsole(lines),
		})

		sink(
			record(
				'debug',
				{ pluginDisplayName: 'Orders' },
				debugLogCategory('test-root', 'hmr:cache', plugin),
			),
		)

		const output = lines.join('')
		expect(output).toContain('Orders (@test/orders::OrdersPlugin)')
		expect(output).toContain('hmr:cache')
	})
})

function captureConsole(lines: string[]): Console {
	const write = (...values: unknown[]) => lines.push(values.map(String).join(' '))
	return {
		debug: write,
		info: write,
		log: write,
		warn: write,
		error: write,
	} as unknown as Console
}
