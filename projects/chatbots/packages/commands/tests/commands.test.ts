import { describe, expect, it } from 'vitest'
import { CommandRegistry, tokenizeCommand } from '../src/index.ts'

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
})
