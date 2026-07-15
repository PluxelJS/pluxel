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
	const identity = parsePackageIdentity(input)
	const prefixes = pluginPrefixes
	const packageSegment = applyPluginPrefix(identity.name, prefixes)
	const name = stripPluginPrefix(packageSegment, prefixes)
	return {
		scope: identity.scope,
		name,
		packageName: identity.scope ? `${identity.scope}/${packageSegment}` : packageSegment,
	}
}

export function parsePackageIdentity(input: string) {
	const raw = String(input).trim()
	if (!raw) throw new Error('Missing packageName')
	const match = raw.match(/^(@[^/]+)\/(.+)$/)
	if (!match) {
		const name = kebabCase(raw)
		return { scope: '', name, packageName: name }
	}
	const scope = match[1]!
	const name = kebabCase(match[2])
	return { scope, name, packageName: `${scope}/${name}` }
}

function applyPluginPrefix(name: string, prefixes: string[]) {
	if (prefixes.length === 0) return name
	for (const prefix of prefixes) {
		if (hasPluginPrefix(name, prefix)) return name
	}
	const fallback = prefixes[0]!
	const separator = fallback.endsWith('-') || name.startsWith('-') ? '' : '-'
	return `${fallback}${separator}${name}`
}

function stripPluginPrefix(name: string, prefixes: string[]) {
	for (const prefix of prefixes) {
		if (!hasPluginPrefix(name, prefix)) continue
		const stripped = name.slice(prefix.length).replace(/^-+/, '')
		return stripped || name
	}
	return name
}

function hasPluginPrefix(name: string, prefix: string) {
	if (!prefix) return false
	return prefix.endsWith('-') ? name.startsWith(prefix) : name.startsWith(`${prefix}-`)
}
