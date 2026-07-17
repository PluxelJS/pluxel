import { readFileSync } from 'node:fs'

/** Build-time loader; the authoritative update-field inventory is inlined by the macro transform. */
export function telegramUpdateKeys(): string[] {
	const source = readFileSync(new URL('./updates.txt', import.meta.url), 'utf8')
	const keys = new Set<string>()
	for (const originalLine of source.split(/\r?\n/)) {
		const key = originalLine.replace(/#.*/, '').trim()
		if (!key) continue
		if (!/^[a-z][a-z0-9_]*$/.test(key))
			throw new Error(`[chatbots-telegram] invalid update field: ${JSON.stringify(originalLine)}`)
		if (keys.has(key)) throw new Error(`[chatbots-telegram] duplicate update field: ${key}`)
		keys.add(key)
	}
	return [...keys]
}
