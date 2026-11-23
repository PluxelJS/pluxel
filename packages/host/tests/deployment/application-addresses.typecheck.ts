import { expectTypeOf } from 'vitest'
import { BasePlugin, type PluginDefinitionAddress } from '@pluxel/core'
import {
	defineHostApplication,
	type HostPluginDeclaration,
	type HostPluginNodesDeclaration,
} from '@pluxel/host'
import type { PluginDescriptor } from '@pluxel/agent-sdk/host'

declare class Worker extends BasePlugin {}
declare const generated: PluginDescriptor<{ workers?: number }, { workers: number }, Worker>
declare const discovered: PluginDefinitionAddress

defineHostApplication(() => ({
	plugins: [{ plugin: Worker, autoStart: true, config: { workers: 2 } }],
}))
defineHostApplication(() => ({
	sources: [{ directory: './plugins', include: ['*.mjs'] }],
	pluginNodes: [
		{
			definition: generated.address(),
			autoStart: true,
			forks: { east: { config: { workers: 3 } } },
		},
		{ definition: discovered, autoStart: true },
	],
}))

// @ts-expect-error Only constructors belong in the plugins declaration.
const invalidPlugin: HostPluginDeclaration = { plugin: generated }
// @ts-expect-error Address declarations take definition addresses.
const invalidTarget: HostPluginNodesDeclaration = { definition: generated.nodeAddress() }
const invalidFork: HostPluginDeclaration = {
	plugin: Worker,
	// @ts-expect-error A configuration-only fork cannot request startup.
	forks: { east: { deploy: false, autoStart: true } },
}
void [invalidPlugin, invalidTarget, invalidFork]

import {
	defineHostApplication as definePortableApplication,
	installOwnerViewService,
	installRootService,
	installScopeService,
} from '@pluxel/host/application'
import { startHost } from '@pluxel/host/embedded'
import { createWorkerHost } from '@pluxel/host/cloudflare'

const shared = definePortableApplication(({ env }) => ({
	plugins: env.WORKERS === '1' ? [{ plugin: Worker }] : [],
}))
void startHost(shared, { env: { WORKERS: '1' } })
const worker = createWorkerHost(shared)
declare const ctx: { waitUntil(work: Promise<unknown>): void }
void worker.run({ ctx, env: { WORKERS: '0' } }, () => 1)
void worker.run(
	{ ctx, signal: new AbortController().signal, responseBody: 'scope' },
	() => new Response(),
)
// @ts-expect-error Resource handles belong to the event callback.
void startHost(shared, { bindings: { id: 1 } })
// @ts-expect-error Deployment inputs only admit strings or undefined.
void worker.run({ ctx, env: { DATABASE: { read() {} } } }, () => 1)
// @ts-expect-error Worker event admission requires the native event context.
void worker.run({}, () => 1)
// @ts-expect-error A retained response body needs its disconnect signal.
void worker.run({ ctx, responseBody: 'scope' }, () => new Response())
// @ts-expect-error A source directory requires the Node module loader.
void startHost(defineHostApplication(() => ({ sources: [{ directory: './plugins' }] })))
const withZenFS = definePortableApplication(() => ({ coreConfig: { zenfs: {} } }))
// @ts-expect-error A Worker's application cannot configure ZenFS.
void createWorkerHost(withZenFS)

// The same Core facilities are typed on service contexts in every application runtime.
type CoreInstallers = typeof import('@pluxel/core/host')
expectTypeOf(installRootService).toEqualTypeOf<CoreInstallers['installRootService']>()
expectTypeOf(installScopeService).toEqualTypeOf<CoreInstallers['installScopeService']>()
expectTypeOf(installOwnerViewService).toEqualTypeOf<CoreInstallers['installOwnerViewService']>()
// @ts-expect-error Portable applications receive the deployment environment.
definePortableApplication((startup) => ({ name: startup.root }))
// @ts-expect-error Reject extra fields even alongside valid portable options.
definePortableApplication(() => ({ plugins: [], typo: true }))
