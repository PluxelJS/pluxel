import { readFileSync } from 'node:fs'

/** Build-time source loader. The endpoint table is inlined by the macro transform. */
export function kookApiEndpoints(): Array<readonly [string, string, string]> {
	const source = readFileSync(new URL('./endpoints.txt', import.meta.url), 'utf8')
	const endpoints: Array<readonly [string, string, string]> = []
	const names = new Set<string>()
	for (const originalLine of source.split(/\r?\n/)) {
		const line = originalLine.replace(/#.*/, '').trim()
		if (!line) continue
		const fields = line.split(/\s+/)
		if (fields.length !== 3) {
			throw new Error(`[chatbots-kook] invalid endpoint: ${JSON.stringify(originalLine)}`)
		}
		const [name, method, path] = fields as [string, string, string]
		if (!/^[A-Za-z_$][\w$]*$/.test(name) || names.has(name))
			throw new Error(`[chatbots-kook] invalid or duplicate endpoint name: ${name}`)
		if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !path.startsWith('/'))
			throw new Error(`[chatbots-kook] invalid endpoint metadata: ${JSON.stringify(originalLine)}`)
		names.add(name)
		endpoints.push([name, method, path])
	}
	return endpoints
}
