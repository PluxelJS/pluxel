import { resolve } from 'node:path'
import { define, type ArgValues } from 'gunshi'
import { devSyncArgs, devSyncDefinition } from './manifest'
import { validateCommandOptions } from './options'
import { resolveDevSelection } from '../client/project'
import { syncPluginControl, HostClientError } from '../client'
import { scriptFailure } from '@pluxel/host/internal/agent/runtime'
import { printFailure, printValue } from './output'

export const devSyncCommand = define({
	...devSyncDefinition,
	async run(ctx) {
		try {
			await validateCommandOptions(ctx)
			const values = ctx.values as ArgValues<typeof devSyncArgs>
			const selection = await resolveDevSelection(values)
			const out = values.out ? resolve(values.out) : resolve(selection.root, '.pluxel/control')
			const value = await syncPluginControl({
				target: {
					root: values.root ?? selection.project.workspace,
					profile: values.profile,
					instance: values.instance,
				},
				out,
			})
			printValue(ctx.log, value)
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
