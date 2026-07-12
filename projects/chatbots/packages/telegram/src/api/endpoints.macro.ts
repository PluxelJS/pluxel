import { readFileSync } from 'node:fs'

/** Build-time source loader; the endpoint inventory is inlined by the macro transform. */
export function telegramApiEndpoints(): Array<readonly [string, 'GET' | 'POST']> {
	const source = readFileSync(new URL('./endpoints.txt', import.meta.url), 'utf8')
	const names = new Set<string>()
	const endpoints: Array<readonly [string, 'GET' | 'POST']> = []
	for (const originalLine of source.split(/\r?\n/)) {
		const line = originalLine.replace(/#.*/, '').trim()
		if (!line) continue
		const fields = line.split(/\s+/)
		if (fields.length !== 2 || (fields[1] !== 'GET' && fields[1] !== 'POST'))
			throw new Error(`[chatbots-telegram] invalid endpoint: ${JSON.stringify(originalLine)}`)
		if (names.has(fields[0]!))
			throw new Error(`[chatbots-telegram] duplicate endpoint: ${fields[0]}`)
		names.add(fields[0]!)
		endpoints.push([fields[0]!, fields[1]])
	}
	return endpoints
}
