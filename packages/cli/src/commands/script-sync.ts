import { define, type ArgValues } from 'gunshi'
import { scriptSyncArgs, scriptSyncDefinition } from '../command-manifest'
import { validateCommandOptions } from '../command-options'
import { readScriptCredentials } from '../script/credentials'
import { syncPluginControl, HostClientError } from '@pluxel/agent-sdk/client'
import { scriptFailure } from '@pluxel/host/internal/agent/runtime'
import { printFailure, printValue } from '../script/output'

export const scriptSyncCommand = define({
	...scriptSyncDefinition,
	async run(ctx) {
		try {
			validateCommandOptions(ctx)
			const values = ctx.values as ArgValues<typeof scriptSyncArgs>
			printValue(
				ctx.log,
				await syncPluginControl({
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
