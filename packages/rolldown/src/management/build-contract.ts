import { existsSync, readFileSync } from 'node:fs'
import type { ModuleFederationOptions } from '@module-federation/vite'
import { resolve } from 'pathe'
import type { InlineConfig, Plugin, PluginOption } from 'vite'
import { resolvePackageJsonPathWithOxc } from '../resolver/oxc.ts'

export type ResolvedFederationShared = {
	shared: ModuleFederationOptions['shared']
	signature: string
	resolveRoot: string
}

function collectPluginNames(input: PluginOption | undefined, out: string[]): void {
	if (!input) return
	if (Array.isArray(input)) {
		for (const item of input) collectPluginNames(item, out)
		return
	}
	const plugin = input as Plugin
	if (typeof plugin.name === 'string' && plugin.name.length > 0) out.push(plugin.name)
	else out.push('anonymous')
}

export function resolveManagementUiBuildSignature(
	vite: InlineConfig | undefined,
	cacheKey?: string,
): string {
	const pluginNames: string[] = []
	collectPluginNames(vite?.plugins, pluginNames)

	return [
		cacheKey?.trim() ? `cacheKey:${cacheKey.trim()}` : '',
		pluginNames.length > 0 ? `plugins:${pluginNames.join('|')}` : '',
		vite?.resolve ? `resolve:${stableJsonish(vite.resolve)}` : '',
		vite?.define ? `define:${stableJsonish(vite.define)}` : '',
		vite?.build ? `build:${stableJsonish(vite.build)}` : '',
		vite?.css ? `css:${stableJsonish(vite.css)}` : '',
	]
		.filter(Boolean)
		.join('\n')
}

function stableJsonish(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'function') {
		return `[function ${(value as { readonly name?: string }).name || 'anonymous'}]`
	}
	if (value instanceof RegExp) return value.toString()
	if (Array.isArray(value)) return `[${value.map((item) => stableJsonish(item)).join(',')}]`
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a.localeCompare(b),
		)
		return `{${entries.map(([key, item]) => `${key}:${stableJsonish(item)}`).join(',')}}`
	}
	return JSON.stringify(value)
}

export function resolveManagementFederationShared(
	root: string,
	sharedPackages: readonly string[],
): ResolvedFederationShared {
	const resolveRoot = findWorkspaceRoot(root) ?? root
	const specs = sharedPackages.map((pkg) => ({
		packageName: pkg,
		version: resolveSharedPackageVersion(resolveRoot, pkg),
	}))
	const signature = specs.map((spec) => `${spec.packageName}@${spec.version ?? '*'}`).join('|')
	const shared = Object.fromEntries(
		specs.map((spec) => [
			spec.packageName,
			{
				version: spec.version,
				singleton: true,
				import: false as const,
				requiredVersion: false as const,
			},
		]),
	) as unknown as ModuleFederationOptions['shared']

	return { shared, signature, resolveRoot }
}

function resolveSharedPackageVersion(root: string, packageName: string): string | undefined {
	const packageJsonPath = resolvePackageJsonPathWithOxc(root, packageName, {
		conditionNames: ['import', 'module', 'browser', 'default'],
		tsconfig: 'auto',
	})
	if (!packageJsonPath) return undefined

	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown }
		return typeof parsed.version === 'string' ? parsed.version : undefined
	} catch {
		return undefined
	}
}

function findWorkspaceRoot(start: string): string | null {
	let current = start
	for (let depth = 0; depth < 12; depth += 1) {
		if (
			existsSync(resolve(current, 'pnpm-workspace.yaml')) ||
			existsSync(resolve(current, 'pnpm-lock.yaml'))
		) {
			return current
		}
		const parent = resolve(current, '..')
		if (parent === current) break
		current = parent
	}
	return null
}
