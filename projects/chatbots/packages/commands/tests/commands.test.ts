import { describe, expect, it } from 'vitest'
import {
	CommandRegistry,
	parseCommandLine,
	runCommandMiddleware,
	tokenizeCommand,
	type ChatCommandContext,
} from '../src/index.ts'

describe('commands', () => {
	it('tokenizes quoted arguments without a parser framework', () => {
		expect(tokenizeCommand(`say "hello world" 'again'`)).toEqual(['say', 'hello world', 'again'])
	})

	it('rejects trigger conflicts and cleans registrations', () => {
		const commands = new CommandRegistry()
		const dispose = commands.register({
			name: 'ping',
			description: 'ping',
			aliases: ['p'],
			execute() {},
		})
		expect(() => commands.register({ name: 'p', description: 'conflict', execute() {} })).toThrow(
			/already registered/,
		)
		dispose()
		expect(commands.list()).toEqual([])
	})

	it('resolves hierarchical routes and parses flags', () => {
		const commands = new CommandRegistry()
		commands.register({
			name: 'admin reload',
			aliases: ['ops reload'],
			description: 'reload',
			execute() {},
		})
		expect(commands.resolve(['ops', 'reload', 'worker'])?.consumed).toBe(2)
		expect(parseCommandLine('admin reload --force --target=api file').flags).toEqual({
			force: true,
			target: 'api',
		})
	})

	it('retains source spans for quoted raw arguments', () => {
		const input = `say "hello world" --style='very loud'`
		const parsed = parseCommandLine(input)
		expect(input.slice(parsed.tokenSpans[0]!.end).trimStart()).toBe(
			`"hello world" --style='very loud'`,
		)
		expect(parsed.positionals).toEqual(['say', 'hello world'])
		expect(parsed.flags.style).toBe('very loud')
	})

	it('prevents middleware from executing downstream commands twice', async () => {
		let executions = 0
		const context = {} as ChatCommandContext
		await expect(
			runCommandMiddleware(
				context,
				[
					async (_context, next) => {
						await next()
						await next()
					},
				],
				() => void executions++,
			),
		).rejects.toThrow('multiple times')
		expect(executions).toBe(1)
	})
})
