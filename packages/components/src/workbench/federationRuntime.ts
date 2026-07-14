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
import type { WorkbenchBundle } from '@pluxel/runtime/workbench'
import type { WorkbenchUiModule } from '@pluxel/runtime/workbench/ui'
import {
	WORKBENCH_FEDERATION_SHARE_STRATEGY,
	workbenchFederationModuleId,
} from '@pluxel/core/federation'
import * as RuntimeWorkbenchUi from '@pluxel/runtime/workbench/ui'

type WorkbenchFederationState = {
	runtime: ModuleFederation
	remoteRegistrations: Map<string, string>
}

const WORKBENCH_FEDERATION_STATE = Symbol.for('pluxel.workbench.federation-runtime')
const federationGlobal = globalThis as typeof globalThis & Record<PropertyKey, unknown>
const sharedVersions = {
	mantineCore: normalizeSharedVersion(componentsPkg.peerDependencies['@mantine/core']),
	mantineHooks: normalizeSharedVersion(componentsPkg.peerDependencies['@mantine/hooks']),
	reactVirtual: normalizeSharedVersion(componentsPkg.dependencies['@tanstack/react-virtual']),
	runtimeWorkbenchUi: runtimePkg.version,
}

export function ensureWorkbenchFederationRuntime(): ModuleFederation {
	return ensureWorkbenchFederationState().runtime
}

function ensureWorkbenchFederationState(): WorkbenchFederationState {
	const existing = federationGlobal[WORKBENCH_FEDERATION_STATE] as
		| WorkbenchFederationState
		| undefined
	if (existing) return existing
	const runtime = createInstance({
		name: 'pluxel-workbench-host',
		remotes: [],
		shareStrategy: WORKBENCH_FEDERATION_SHARE_STRATEGY,
		shared: {
			react: sharedModule(React, React.version),
			'react/jsx-runtime': sharedModule(ReactJSXRuntime, React.version),
			'react/jsx-dev-runtime': sharedModule(ReactJSXDevRuntime, React.version),
			'react-dom': sharedModule(ReactDOM, ReactDOM.version),
			'react-dom/client': sharedModule(ReactDOMClient, ReactDOM.version),
			'@tanstack/react-virtual': sharedModule(ReactVirtual, sharedVersions.reactVirtual),
			'@mantine/core': sharedModule(MantineCore, sharedVersions.mantineCore),
			'@mantine/hooks': sharedModule(MantineHooks, sharedVersions.mantineHooks),
			'@pluxel/runtime/workbench/ui': sharedModule(
				RuntimeWorkbenchUi,
				sharedVersions.runtimeWorkbenchUi,
			),
		},
	} as Parameters<typeof createInstance>[0])
	const state = { runtime, remoteRegistrations: new Map<string, string>() }
	federationGlobal[WORKBENCH_FEDERATION_STATE] = state
	return state
}

export async function loadFederatedWorkbenchModule(
	artifact: WorkbenchBundle,
): Promise<WorkbenchUiModule | { default?: WorkbenchUiModule }> {
	const state = ensureWorkbenchFederationState()
	const runtime = state.runtime
	const entry = withCacheBusting(artifact.manifestUrl, artifact.sourceHash, artifact.compiledAt)
	let registrationName = state.remoteRegistrations.get(entry)
	if (!registrationName) {
		registrationName = `${artifact.remoteName}_${artifact.sourceHash}_${artifact.compiledAt}`
		runtime.registerRemotes([{ name: registrationName, entry }])
		state.remoteRegistrations.set(entry, registrationName)
	}
	const loaded = await runtime.loadRemote<WorkbenchUiModule | { default?: WorkbenchUiModule }>(
		`${registrationName}/${workbenchFederationModuleId(artifact.exposedModule)}`,
		{ from: 'runtime' },
	)
	if (!loaded) throw new Error(`Failed to load workbench UI module: ${artifact.pluginName}`)
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
