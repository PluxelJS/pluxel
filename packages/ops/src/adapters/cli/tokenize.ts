import { OpError, type CliToken } from '../../types'

export const tokenizeCli = (text: string): CliToken[] => {
	const out: CliToken[] = []
	let index = 0

	const pushToken = (start: number, end: number, value: string) => {
		out.push({ start, end, value, raw: text.slice(start, end) })
	}

	while (index < text.length) {
		while (index < text.length && /\s/.test(text[index]!)) index += 1
		if (index >= text.length) break

		const start = index
		let value = ''
		let mode: 'plain' | 'single' | 'double' = 'plain'

		while (index < text.length) {
			const current = text[index]!
			if (mode === 'plain') {
				if (/\s/.test(current)) break
				if (current === "'") {
					mode = 'single'
					index += 1
					continue
				}
				if (current === '"') {
					mode = 'double'
					index += 1
					continue
				}
				if (current === '\\') {
					index += 1
					if (index >= text.length) {
						throw new OpError('E_CLI_PARSE', 'Invalid command text', {
							message: 'Dangling escape in command text',
							details: { reason: 'dangling_escape', at: { start, end: index, raw: text.slice(start, index) } },
						})
					}
					value += text[index]!
					index += 1
					continue
				}
				value += current
				index += 1
				continue
			}

			if (mode === 'single') {
				if (current === "'") {
					mode = 'plain'
					index += 1
					continue
				}
				value += current
				index += 1
				continue
			}

			if (current === '"') {
				mode = 'plain'
				index += 1
				continue
			}
			if (current === '\\') {
				index += 1
				if (index >= text.length) {
					throw new OpError('E_CLI_PARSE', 'Invalid command text', {
						message: 'Dangling escape in command text',
						details: { reason: 'dangling_escape', at: { start, end: index, raw: text.slice(start, index) } },
					})
				}
				value += text[index]!
				index += 1
				continue
			}
			value += current
			index += 1
		}

		if (mode !== 'plain') {
			throw new OpError('E_CLI_PARSE', 'Invalid command text', {
				message: 'Unterminated quoted string',
				details: { reason: 'unterminated_quote', at: { start, end: index, raw: text.slice(start, index) } },
			})
		}

		pushToken(start, index, value)
	}

	return out
}
