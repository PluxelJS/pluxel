import { define, type ArgValues } from 'gunshi'
import { scriptSyncArgs, scriptSyncDefinition } from '../command-manifest'
import { validateCommandOptions } from '../command-options'
import { connectRuntimeTarget, readScriptCredentials } from '../script/session'
import { syncPluginControl } from '../script/sync'
import { ScriptExecutionError, scriptFailure } from '@pluxel/host/agent'

export const scriptSyncCommand = define({
	...scriptSyncDefinition,
	async run(ctx) {
		try {
			validateCommandOptions(ctx)
			const values = ctx.values as ArgValues<typeof scriptSyncArgs>
			using connection = await connectRuntimeTarget({
				endpoint: values.endpoint,
				credentials: await readScriptCredentials(values['credentials-file']),
			})
			if (!connection.description.protocol.capabilities.includes('plugins.control-materials'))
				throw new ScriptExecutionError(
					'control_material_unavailable',
					'This Host does not expose Plugin control material',
				)
			ctx.log(
				JSON.stringify(
					await syncPluginControl({ source: connection.management.materials, out: values.out }),
				),
			)
		} catch (error) {
			ctx.log(JSON.stringify({ error: scriptFailure(error, 'control_sync_failed') }))
			process.exitCode = 1
		}
	},
})
