import type { PackageJson } from 'pkg-types'
import { runCommand, type ExecOptions } from '../utils/exec'

export const publicNpmRegistry = 'https://registry.npmjs.org'

export function canonicalRegistry(value: string): string {
	const url = new URL(value)
	const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
	if (
		value !== value.trim() ||
		!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
		url.username ||
		url.password ||
		value.includes('?') ||
		value.includes('#')
	) {
		throw new TypeError(
			'The npm registry must be an HTTPS base URL (HTTP is allowed only on loopback), without credentials, query or fragment',
		)
	}
	return url.href.replace(/\/+$/, '')
}

async function npmConfig(keys: string[], options: ExecOptions): Promise<Record<string, string>> {
	const result = await runCommand('npm', ['config', 'get', ...keys, '--workspaces=false'], options)
	if (result.code !== 0) throw new Error('Unable to read the effective npm registry configuration')
	const output = result.stdout.replace(/\r?\n$/, '')
	if (keys.length === 1) return { [keys[0]]: output }
	const values: Record<string, string> = {}
	for (const line of output.split(/\r?\n/)) {
		const separator = line.indexOf('=')
		const key = line.slice(0, separator)
		if (separator < 1 || !keys.includes(key) || Object.hasOwn(values, key))
			throw new Error('npm config returned an unexpected registry configuration response')
		values[key] = line.slice(separator + 1)
	}
	if (keys.some((key) => !Object.hasOwn(values, key)))
		throw new Error('npm config omitted a requested registry configuration value')
	return values
}

/** Match npm publish's publishConfig overlay, then npm-registry-fetch.pickRegistry. */
export async function resolvePublishTarget(
	pkg: PackageJson,
	options: ExecOptions & { access?: string },
): Promise<{ registry: string; access: string | null }> {
	const packageScope = pkg.name?.startsWith('@') ? pkg.name.split('/')[0] : undefined
	const keys = [
		'registry',
		'scope',
		'access',
		...(packageScope ? [`${packageScope}:registry`] : []),
	]
	const config = await npmConfig(keys, { cwd: options.cwd, env: options.env })
	const publishConfig = (pkg.publishConfig ?? {}) as Record<string, unknown>
	const value = (key: string): string | undefined => {
		if (Object.hasOwn(publishConfig, key)) {
			const selected = publishConfig[key]
			if (selected === null || selected === '') return undefined
			if (typeof selected !== 'string') throw new TypeError(`publishConfig.${key} must be a string`)
			return selected
		}
		const selected = config[key]
		return selected === 'undefined' || selected === 'null' || selected === '' ? undefined : selected
	}
	const rawScope = value('scope')
	const fallbackScope = rawScope && (rawScope.startsWith('@') ? rawScope : `@${rawScope}`)
	if (fallbackScope && !Object.hasOwn(config, `${fallbackScope}:registry`)) {
		Object.assign(config, await npmConfig([`${fallbackScope}:registry`], options))
	}
	const registry =
		(packageScope && value(`${packageScope}:registry`)) ||
		(fallbackScope && value(`${fallbackScope}:registry`)) ||
		value('registry') ||
		publicNpmRegistry
	const access = options.access ?? value('access') ?? null
	return {
		registry: canonicalRegistry(registry),
		access: access === 'private' ? 'restricted' : access,
	}
}
