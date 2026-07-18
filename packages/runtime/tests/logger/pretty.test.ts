import type { LogRecord } from '@logtape/logtape'
import { describe, expect, it } from 'vitest'
import { createRuntimePrettyConsoleSink } from '../../src/logger/pretty'

function record(level: LogRecord['level'], properties: LogRecord['properties']): LogRecord {
	return {
		category: ['pluxel', 'plugins', 'test-root', 'DemoPlugin'],
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

		expect(lines.join('')).toContain('plugin event')
		expect(lines.join('')).not.toContain('operation')
	})

	it('renders warning and error diagnostics without reserved identity properties', () => {
		const lines: string[] = []
		const sink = createRuntimePrettyConsoleSink({
			caller: false,
			timezone: 'utc',
			console: captureConsole(lines),
		})
		const error = new Error('visible root cause')

		sink(record('error', { context: 'hidden-context', error, attempt: 2 }))

		const output = lines.join('')
		expect(output).toContain('visible root cause')
		expect(output).toContain('attempt')
		expect(output).not.toContain('hidden-context')
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
