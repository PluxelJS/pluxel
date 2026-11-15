import { BasePlugin, type PluginNodeAddress } from '@pluxel/core'
import { defineHostApplication, type HostPolicyOptions } from '@pluxel/host'
import type { PluginDescriptor } from '@pluxel/agent-sdk/host'
import { pluginSource } from '@pluxel/host/sources'

declare class Worker extends BasePlugin {}
declare const generated: PluginDescriptor<{ workers?: number }, { workers: number }, Worker>
declare const discovered: PluginNodeAddress

defineHostApplication(() => ({
	plugins: [Worker],
	policy: { autoStart: [Worker.nodeAddress()] },
	config: { records: [{ owner: Worker.nodeAddress(), config: { workers: 2 } }] },
}))
defineHostApplication(() => ({
	plugins: [],
	sources: [pluginSource({ kind: 'directory', path: './plugins', include: ['*.mjs'] })],
	policy: {
		autoStart: [generated.nodeAddress(), discovered],
		forks: [generated.nodeAddress('east')],
	},
	config: { records: [{ owner: generated.nodeAddress('east'), config: { workers: 3 } }] },
}))
const invalidPolicy: HostPolicyOptions = {
	// @ts-expect-error Startup selects nodes by address, not by implementation or provider.
	autoStart: [Worker, generated],
}
void invalidPolicy
