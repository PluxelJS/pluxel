import type { LogRecord } from '@logtape/logtape'
import { debugLogCategory, pluginLogCategory } from '@pluxel/core/logger'
import { describe, expect, it } from 'vitest'
import { createRuntimePrettyConsoleSink } from '../../src/logger/pretty'

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
