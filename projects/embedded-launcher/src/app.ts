import {
	defineHostApplication,
	type HostApplication,
	type PluginHost,
	type HostDocumentStorage,
	type HostStateStoreOptions,
} from '@pluxel/host'
import {
	parsePluginNodeReference,
	pluginDefinitionAddressOf,
	type PluginConstructor,
} from '@pluxel/core'
import { pluginSource } from '@pluxel/host/sources'
import { commands } from '@pluxel/services/commands'
import {
	nativeServices,
	observations,
	network,
	launcher,
	desktop,
	cli,
	LauncherControl,
	type NativeTransport,
} from '@embedded-launcher/sdk'
import { createControl } from './execution/control'
export interface ExecutionBindings {
	transport: NativeTransport
	configStorage?: HostDocumentStorage
	stateStorage?: HostDocumentStorage
	plugins?: readonly PluginConstructor[]
	attachHost?(input: {
		host: PluginHost
		lease: string
		dispatch(text: string): Promise<string>
	}): () => Promise<void>
}
const defaultNames = ['CalculatorLauncher', 'CalculatorCommands', 'NativeActions', 'RemoteLookup']
export default defineHostApplication(({ bindings }): HostApplication => {
	const execution = bindings as unknown as ExecutionBindings
	if (!execution.transport || typeof execution.transport.request !== 'function')
		throw new TypeError('Launcher transport binding required')
	const available = execution.plugins
		? new Set(execution.plugins.map((plugin) => pluginDefinitionAddressOf(plugin).exportName))
		: undefined
	const autoStart = defaultNames
		.filter((name) => !available || available.has(name))
		.map((name) => parsePluginNodeReference(`package:@embedded-launcher/app/plugins::${name}`))
	let state: HostStateStoreOptions = { initial: { autoStart } }
	if (execution.stateStorage) state = { initial: { autoStart }, storage: execution.stateStorage }
	return {
		plugins: execution.plugins ?? [],
		...(execution.plugins
			? {}
			: { sources: [pluginSource({ kind: 'file', path: 'src/plugins/index.ts' })] }),
		services: [
			observations(),
			network(),
			commands(),
			nativeServices(execution.transport),
			launcher(execution.transport, true),
			desktop(execution.transport, true),
			cli(),
		],
		state,
		...(execution.configStorage ? { configRecords: { storage: execution.configStorage } } : {}),
		prepare({ host }: { host: PluginHost }) {
			const control = createControl(host)
			const lease = host.ctx.require(LauncherControl).lease
			const detach = execution.attachHost?.({ host, lease, dispatch: control.dispatch })
			host.ctx.effects.defer(
				async () => {
					control.close()
					await detach?.()
				},
				{ tag: 'Execution Host binding' },
			)
		},
	}
})
