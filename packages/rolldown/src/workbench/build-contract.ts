import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ModuleFederationOptions } from '@module-federation/vite'
import { resolve } from 'pathe'
import { workbenchFederationSharedPackages } from '@pluxel/core/federation'
import { resolvePackageJsonPathWithOxc } from '../resolver/oxc.ts'

export type ResolvedFederationShared = {
	shared: ModuleFederationOptions['shared']
	signature: string
	resolveRoot: string
}

const require = createRequire(import.meta.url)
const WORKBENCH_UI_BUILD_CONTRACT_VERSION = 3
const workbenchUiToolchainSignature = [
	`pluxel@${WORKBENCH_UI_BUILD_CONTRACT_VERSION}`,
	`@module-federation/vite@${resolveToolchainPackageVersion('@module-federation/vite')}`,
	`vite@${resolveToolchainPackageVersion('vite')}`,
].join('|')

export function resolveWorkbenchFederationShared(root: string): ResolvedFederationShared {
	const resolveRoot = findWorkspaceRoot(root) ?? root
	const specs = workbenchFederationSharedPackages.map((pkg) => ({
		packageName: pkg,
		version: resolveSharedPackageVersion(resolveRoot, pkg),
	}))
	const signature = [
		`builder:${workbenchUiToolchainSignature}`,
		`shared:${specs.map((spec) => `${spec.packageName}@${spec.version ?? '*'}`).join('|')}`,
	].join('|')
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

function resolveToolchainPackageVersion(packageName: string): string {
	try {
		const packageJson = JSON.parse(
			readFileSync(require.resolve(`${packageName}/package.json`), 'utf-8'),
		) as { version?: unknown }
		return typeof packageJson.version === 'string' ? packageJson.version : 'unknown'
	} catch {
		return 'unknown'
	}
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
