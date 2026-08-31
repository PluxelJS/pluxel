import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
	WORKBENCH_FEDERATION_REACT_BRIDGE_VERSION,
	WORKBENCH_FEDERATION_RUNTIME_VERSION,
	WORKBENCH_FEDERATION_MANTINE_VERSION,
	WORKBENCH_FEDERATION_SHARED_MODULES,
	WORKBENCH_FEDERATION_VITE_VERSION,
	WORKBENCH_PROFILE_VERSION,
	createWorkbenchFederationCompatibilitySet,
	type WorkbenchFederationCompatibilitySet,
} from '@pluxel/core/federation'
import type { ModuleFederationOptions } from '@module-federation/vite'
import { resolve } from 'pathe'
import { resolvePackageJsonPathWithOxc } from '../resolver/oxc.ts'

export type { WorkbenchFederationCompatibilitySet } from '@pluxel/core/federation'

export type ResolvedFederationShared = Readonly<{
	shared: ModuleFederationOptions['shared']
	signature: string
	resolveRoot: string
	compatibility: WorkbenchFederationCompatibilitySet
}>

const require = createRequire(import.meta.url)

export function resolveWorkbenchFederationShared(root: string): ResolvedFederationShared {
	assertToolchainVersion('@module-federation/vite', WORKBENCH_FEDERATION_VITE_VERSION)
	assertModuleFederationRuntimeVersion()
	assertToolchainVersion(
		'@module-federation/bridge-react',
		WORKBENCH_FEDERATION_REACT_BRIDGE_VERSION,
	)

	const sourceRoot = resolve(root)
	const resolveRoot = findWorkspaceRoot(sourceRoot) ?? sourceRoot
	assertOptionalSharedPackageVersion(
		sourceRoot,
		resolveRoot,
		'@mantine/core',
		WORKBENCH_FEDERATION_MANTINE_VERSION,
	)
	assertOptionalSharedPackageVersion(
		sourceRoot,
		resolveRoot,
		'@mantine/hooks',
		WORKBENCH_FEDERATION_MANTINE_VERSION,
	)
	const compatibility = createWorkbenchFederationCompatibilitySet({
		react: resolveRequiredPackageVersion(sourceRoot, resolveRoot, 'react'),
		reactDom: resolveRequiredPackageVersion(sourceRoot, resolveRoot, 'react-dom'),
		runtime: resolveRequiredPackageVersion(sourceRoot, resolveRoot, '@pluxel/runtime'),
	})
	const signature = canonicalCompatibilitySignature(compatibility)
	const shared = Object.fromEntries(
		WORKBENCH_FEDERATION_SHARED_MODULES.map((request) => {
			const version = compatibility.shared[request]
			return [
				request,
				{
					version,
					requiredVersion: version,
					strictVersion: true,
					singleton: true,
					import: false as const,
				},
			]
		}),
	) as unknown as ModuleFederationOptions['shared']

	return Object.freeze({ shared, signature, resolveRoot, compatibility })
}

/** @internal Resolves the Profile-owned Bridge implementation for Vite aliasing. */
export function resolveWorkbenchFederationBridgeEntry(): string {
	try {
		return require.resolve('@module-federation/bridge-react')
	} catch (error) {
		throw new Error(
			`[workbench-ui] Profile ${WORKBENCH_PROFILE_VERSION} Bridge implementation is not installed`,
			{ cause: error },
		)
	}
}

export function canonicalCompatibilitySignature(
	compatibility: WorkbenchFederationCompatibilitySet,
): string {
	return [
		`profile:${compatibility.profile}`,
		`build:${compatibility.buildContract}`,
		`@module-federation/vite@${compatibility.moduleFederation.vite}`,
		`@module-federation/runtime@${compatibility.moduleFederation.runtime}`,
		`@module-federation/bridge-react@${compatibility.moduleFederation.bridgeReact}`,
		...Object.entries(compatibility.shared)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, version]) => `shared:${name}@${version}`),
	].join('|')
}

function assertToolchainVersion(packageName: string, expectedVersion: string): void {
	const actual = resolveToolchainPackageVersion(packageName)
	if (actual !== expectedVersion) {
		throw new Error(
			`[workbench-ui] Profile ${WORKBENCH_PROFILE_VERSION} requires ${packageName}@${expectedVersion}, resolved ${actual}`,
		)
	}
}

function assertModuleFederationRuntimeVersion(): void {
	const vitePackageJson = require.resolve('@module-federation/vite/package.json')
	const viteRequire = createRequire(vitePackageJson)
	let actual = 'missing'
	try {
		actual = readPackageVersion(viteRequire.resolve('@module-federation/runtime/package.json'))
	} catch {
		// A missing transitive runtime is a broken MF Vite installation.
	}
	if (actual !== WORKBENCH_FEDERATION_RUNTIME_VERSION) {
		throw new Error(
			`[workbench-ui] Profile ${WORKBENCH_PROFILE_VERSION} requires @module-federation/runtime@${WORKBENCH_FEDERATION_RUNTIME_VERSION}, resolved ${actual}`,
		)
	}
}

function resolveToolchainPackageVersion(packageName: string): string {
	try {
		return readPackageVersion(require.resolve(`${packageName}/package.json`))
	} catch {
		return 'missing'
	}
}

function resolveRequiredPackageVersion(
	sourceRoot: string,
	workspaceRoot: string,
	packageName: string,
): string {
	const packageJsonPath = resolveSharedPackageJsonPath(sourceRoot, workspaceRoot, packageName)
	if (!packageJsonPath) {
		throw new Error(
			`[workbench-ui] Profile ${WORKBENCH_PROFILE_VERSION} shared package is not installed: ${packageName}`,
		)
	}
	const version = readPackageVersion(packageJsonPath)
	if (version === 'missing') {
		throw new Error(`[workbench-ui] shared package has no exact version: ${packageName}`)
	}
	return version
}

function assertOptionalSharedPackageVersion(
	sourceRoot: string,
	workspaceRoot: string,
	packageName: string,
	expectedVersion: string,
): void {
	const packageJsonPath = resolveSharedPackageJsonPath(sourceRoot, workspaceRoot, packageName)
	if (!packageJsonPath) return
	const actualVersion = readPackageVersion(packageJsonPath)
	if (actualVersion !== expectedVersion) {
		throw new Error(
			`[workbench-ui] Profile ${WORKBENCH_PROFILE_VERSION} requires ${packageName}@${expectedVersion}, resolved ${actualVersion}`,
		)
	}
}

function resolveSharedPackageJsonPath(
	sourceRoot: string,
	workspaceRoot: string,
	packageName: string,
): string | undefined {
	const resolveFrom = (root: string) =>
		resolvePackageJsonPathWithOxc(root, packageName, {
			conditionNames: ['import', 'module', 'browser', 'default'],
			tsconfig: 'auto',
		})
	return (
		resolveFrom(sourceRoot) ??
		(sourceRoot === workspaceRoot ? undefined : resolveFrom(workspaceRoot))
	)
}

function readPackageVersion(packageJsonPath: string): string {
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown }
		return typeof parsed.version === 'string' && parsed.version.length > 0
			? parsed.version
			: 'missing'
	} catch {
		return 'missing'
	}
}

function findWorkspaceRoot(start: string): string | null {
	let current = resolve(start)
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
