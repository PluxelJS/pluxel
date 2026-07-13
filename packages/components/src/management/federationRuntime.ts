import componentsPkg from '../../package.json'
import * as MantineHooks from '@mantine/hooks'
import runtimePkg from '@pluxel/runtime/package.json'
import { createInstance, type ModuleFederation } from '@module-federation/runtime'
import * as MantineCore from '@mantine/core'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as ReactJSXDevRuntime from 'react/jsx-dev-runtime'
import * as ReactJSXRuntime from 'react/jsx-runtime'
import * as ReactVirtual from '@tanstack/react-virtual'
import type { ManagementUiArtifact } from '@pluxel/runtime/management'
import type { ManagementUiModule } from '@pluxel/runtime/management/ui'
import {
	MANAGEMENT_FEDERATION_SHARE_STRATEGY,
	managementFederationModuleId,
} from '@pluxel/runtime/management/federation'
import * as RuntimeManagementUi from '@pluxel/runtime/management/ui'

let federationRuntime: ModuleFederation | null = null
const sharedVersions = {
	mantineCore: normalizeSharedVersion(componentsPkg.peerDependencies['@mantine/core']),
	mantineHooks: normalizeSharedVersion(componentsPkg.peerDependencies['@mantine/hooks']),
	reactVirtual: normalizeSharedVersion(componentsPkg.dependencies['@tanstack/react-virtual']),
	runtimeManagementUi: runtimePkg.version,
}

export function ensureManagementFederationRuntime(): ModuleFederation {
	if (federationRuntime) return federationRuntime
	federationRuntime = createInstance({
		name: 'pluxel-management-host',
		remotes: [],
		shareStrategy: MANAGEMENT_FEDERATION_SHARE_STRATEGY,
		shared: {
			react: sharedModule(React, React.version),
			'react/jsx-runtime': sharedModule(ReactJSXRuntime, React.version),
			'react/jsx-dev-runtime': sharedModule(ReactJSXDevRuntime, React.version),
			'react-dom': sharedModule(ReactDOM, ReactDOM.version),
			'react-dom/client': sharedModule(ReactDOMClient, ReactDOM.version),
			'@tanstack/react-virtual': sharedModule(ReactVirtual, sharedVersions.reactVirtual),
			'@mantine/core': sharedModule(MantineCore, sharedVersions.mantineCore),
			'@mantine/hooks': sharedModule(MantineHooks, sharedVersions.mantineHooks),
			'@pluxel/runtime/management/ui': sharedModule(
				RuntimeManagementUi,
				sharedVersions.runtimeManagementUi,
			),
		},
	} as Parameters<typeof createInstance>[0])
	return federationRuntime
}

export async function loadFederatedManagementModule(
	artifact: ManagementUiArtifact,
): Promise<ManagementUiModule | { default?: ManagementUiModule }> {
	const runtime = ensureManagementFederationRuntime()
	runtime.registerRemotes(
		[
			{
				name: artifact.remoteName,
				entry: withCacheBusting(artifact.manifestUrl, artifact.sourceHash, artifact.compiledAt),
			},
		],
		{ force: true },
	)
	const loaded = await runtime.loadRemote<ManagementUiModule | { default?: ManagementUiModule }>(
		`${artifact.remoteName}/${managementFederationModuleId(artifact.exposedModule)}`,
		{ from: 'runtime' },
	)
	if (!loaded) throw new Error(`Failed to load management UI module: ${artifact.pluginName}`)
	return loaded
}

function sharedModule(lib: unknown, version: string | undefined) {
	return {
		version: version ?? '0.0.0',
		lib: () => lib as any,
		shareConfig: { singleton: true, requiredVersion: false as const },
	}
}

function normalizeSharedVersion(version: string | undefined): string | undefined {
	const normalized = version?.trim()
	if (!normalized) return undefined
	return /^[~^]?\d+\.\d+\.\d+$/.test(normalized) ? normalized.replace(/^[~^]/, '') : normalized
}

function withCacheBusting(url: string, hash: string, compiledAt: number): string {
	const suffix = `v=${hash}:${compiledAt}`
	return url.includes('?') ? `${url}&${suffix}` : `${url}?${suffix}`
}
