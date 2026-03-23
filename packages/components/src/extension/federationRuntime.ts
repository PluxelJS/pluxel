import componentsPkg from '../../package.json'
import * as MantineHooks from '@mantine/hooks'
import runtimePkg from '@pluxel/runtime/package.json'
import {
	createInstance,
	type ModuleFederation,
} from '@module-federation/runtime'
import * as MantineCore from '@mantine/core'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as ReactJSXDevRuntime from 'react/jsx-dev-runtime'
import * as ReactJSXRuntime from 'react/jsx-runtime'
import {
	EXTENSION_FEDERATION_SHARE_STRATEGY,
	extensionFederationModuleId,
} from '@pluxel/runtime/web/federation'
import type { CompiledExtensionModule } from '@pluxel/runtime/web/extensions'
import type { PluginUIModule } from '@pluxel/runtime/web/ui'
import * as RuntimeWebUi from '@pluxel/runtime/web/ui'

let federationRuntime: ModuleFederation | null = null
const hostSharedVersions = {
	mantineCore: normalizeSharedVersion(componentsPkg.peerDependencies['@mantine/core']),
	mantineHooks: normalizeSharedVersion(componentsPkg.peerDependencies['@mantine/hooks']),
	runtimeWebUi: runtimePkg.version,
}

export function ensureExtensionFederationRuntime(): ModuleFederation {
	if (federationRuntime) return federationRuntime

	federationRuntime = createInstance({
		name: 'pluxel-extension-host',
		remotes: [],
		shareStrategy: EXTENSION_FEDERATION_SHARE_STRATEGY,
		shared: {
			react: sharedModule(React, React.version),
			'react/jsx-runtime': sharedModule(ReactJSXRuntime, React.version),
			'react/jsx-dev-runtime': sharedModule(ReactJSXDevRuntime, React.version),
			'react-dom': sharedModule(ReactDOM, ReactDOM.version),
			'react-dom/client': sharedModule(ReactDOMClient, ReactDOM.version),
			'@mantine/core': sharedModule(MantineCore, hostSharedVersions.mantineCore),
			'@mantine/hooks': sharedModule(MantineHooks, hostSharedVersions.mantineHooks),
			'@pluxel/runtime/web/ui': sharedModule(RuntimeWebUi, hostSharedVersions.runtimeWebUi),
		},
	} as Parameters<typeof createInstance>[0])

	return federationRuntime
}

export async function loadFederatedExtensionModule(
	module: CompiledExtensionModule,
): Promise<PluginUIModule | { default?: PluginUIModule }> {
	const runtime = ensureExtensionFederationRuntime()
	runtime.registerRemotes(
		[
			{
				name: module.remoteName,
				entry: withCacheBusting(module.manifestUrl, module.sourceHash, module.compiledAt),
			},
		],
		{ force: true },
	)

	const loaded = await runtime.loadRemote<PluginUIModule | { default?: PluginUIModule }>(
		`${module.remoteName}/${extensionFederationModuleId(module.exposedModule)}`,
		{ from: 'runtime' },
	)
	if (!loaded) {
		throw new Error(`Failed to load federated extension module: ${module.pluginName}`)
	}
	return loaded
}

function sharedModule(lib: unknown, version: string | undefined) {
	return {
		version: version ?? '0.0.0',
		lib: () => lib as any,
		shareConfig: {
			singleton: true,
			requiredVersion: false as const,
		},
	}
}

function normalizeSharedVersion(version: string | undefined): string | undefined {
	if (!version) return undefined
	const normalized = version.trim()
	if (!normalized) return undefined
	if (/^[~^]?\d+\.\d+\.\d+$/.test(normalized)) {
		return normalized.replace(/^[~^]/, '')
	}
	return normalized
}

function withCacheBusting(url: string, hash: string, compiledAt: number): string {
	const suffix = `v=${hash}:${compiledAt}`
	return url.includes('?') ? `${url}&${suffix}` : `${url}?${suffix}`
}
