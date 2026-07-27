import { CommandError, type ArgumentSyntaxReason } from '../types'
import type { ArgvToken } from './types'

export function tokenizeArgv(input: string): ArgvToken[] {
	const output: ArgvToken[] = []
	let index = 0
	while (index < input.length) {
		while (index < input.length && /\s/.test(input[index]!)) index += 1
		if (index >= input.length) break
		const start = index
		let value = ''
		let quote: "'" | '"' | undefined
		while (index < input.length) {
			const current = input[index]!
			if (!quote && /\s/.test(current)) break
			if (!quote && (current === "'" || current === '"')) {
				quote = current
				index += 1
				continue
			}
			if (quote === current) {
				quote = undefined
				index += 1
				continue
			}
			if (current === '\\' && quote !== "'") {
				index += 1
				if (index >= input.length) {
					throw syntaxError(
						'Dangling escape in command input',
						'dangling_escape',
						input,
						start,
						index,
					)
				}
				value += input[index]!
				index += 1
				continue
			}
			value += current
			index += 1
		}
		if (quote) {
			throw syntaxError('Unterminated quoted string', 'unterminated_quote', input, start, index)
		}
		output.push({ value, raw: input.slice(start, index), start, end: index })
	}
	return output
}

function syntaxError(
	message: string,
	reason: ArgumentSyntaxReason,
	input: string,
	start: number,
	end: number,
): CommandError<'ARGUMENT_SYNTAX'> {
	return new CommandError('ARGUMENT_SYNTAX', 'Invalid command input', {
		message,
		details: { reason, at: { start, end, raw: input.slice(start, end) } },
	})
}
