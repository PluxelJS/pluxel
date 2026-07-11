import { readFileSync } from 'node:fs'

/** Build-time source loader. The endpoint table is inlined by the macro transform. */
export function kookApiEndpoints(): Array<readonly [string, string, string]> {
	const source = readFileSync(new URL('./endpoints.txt', import.meta.url), 'utf8')
	const endpoints: Array<readonly [string, string, string]> = []
	for (const originalLine of source.split(/\r?\n/)) {
		const line = originalLine.replace(/#.*/, '').trim()
		if (!line) continue
		const fields = line.split(/\s+/)
		if (fields.length !== 3) {
			throw new Error(`[chatbots-kook] invalid endpoint: ${JSON.stringify(originalLine)}`)
		}
		endpoints.push([fields[0], fields[1], fields[2]])
	}
	return endpoints
}
