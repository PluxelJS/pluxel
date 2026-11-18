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
