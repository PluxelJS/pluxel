import { define, type ArgValues } from 'gunshi'
import { scriptSyncArgs, scriptSyncDefinition } from './manifest'
import { validateCommandOptions } from './options'
import { parseControlSyncArgs } from './control-sync'
import { readScriptCredentials } from './credentials'
import { syncPluginControl, HostClientError } from '../client'
import { scriptFailure } from '@pluxel/host/internal/agent/runtime'
import { printFailure, printValue } from './output'

export const scriptSyncCommand = define({
	...scriptSyncDefinition,
	async run(ctx) {
		try {
			await validateCommandOptions(ctx)
			const values = ctx.values as ArgValues<typeof scriptSyncArgs>
			const selection = parseControlSyncArgs(values)
			printValue(
				ctx.log,
				await syncPluginControl({
					...selection,
					target: {
						endpoint: values.endpoint,
						credentials: await readScriptCredentials(values['credentials-file']),
					},
					out: values.out,
				}),
			)
		} catch (error) {
			printFailure(
				ctx.log,
				error instanceof HostClientError
					? error.failure
					: scriptFailure(error, 'control_sync_failed'),
			)
		}
	},
})
