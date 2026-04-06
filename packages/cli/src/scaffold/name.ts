import { basename } from 'pathe'

const NAME_SUGGESTION_BLACKLIST = new Set([
	'plugins',
	'packages',
	'workspace',
	'repo',
	'tmp',
	'temp',
])

export function validatePackageName(value: string) {
	const raw = String(value).trim()
	if (!raw) return 'required'
	const ok = /^(@[\w-]+\/)?[a-z0-9][a-z0-9-]*$/i.test(raw)
	return ok ? undefined : 'use @scope/name or name (letters/digits/dashes)'
}

export function suggestPackageName(cwd: string) {
	const base = kebabCase(basename(cwd))
	if (!base || NAME_SUGGESTION_BLACKLIST.has(base)) return undefined
	return base
}

export function kebabCase(s: string) {
	return String(s)
		.trim()
		.replaceAll(/^@[^/]+\/+/g, '')
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '-')
		.replaceAll(/^-+|-+$/g, '')
}

export function pascalCase(s: string) {
	return kebabCase(s)
		.split('-')
		.filter(Boolean)
		.map((word) => word[0]!.toUpperCase() + word.slice(1))
		.join('')
}

export function capitalize(s: string) {
	const text = String(s)
	return text ? text[0]!.toUpperCase() + text.slice(1) : ''
}

export function parsePackageName(input: string, pluginPrefixes: string[]) {
	const raw = String(input).trim()
	if (!raw) throw new Error('Missing packageName')
	const match = raw.match(/^(@[^/]+)\/(.+)$/)
	const prefixes = pluginPrefixes
	if (match) {
		const scope = match[1]
		const scopedName = kebabCase(match[2])
		const scopedPackage = applyPluginPrefix(scopedName, prefixes)
		return { scope, name: scopedName, packageName: `${scope}/${scopedPackage}` }
	}
	const name = kebabCase(raw)
	const packageName = applyPluginPrefix(name, prefixes)
	return { scope: '', name, packageName }
}

function applyPluginPrefix(name: string, prefixes: string[]) {
	if (prefixes.length === 0) return name
	const normalizedName = name
	for (const prefix of prefixes) {
		if (normalizedName.startsWith(prefix)) {
			return normalizedName
		}
	}
	const fallback = prefixes[0]!
	const separator = fallback.endsWith('-') || normalizedName.startsWith('-') ? '' : '-'
	return `${fallback}${separator}${normalizedName}`
}
