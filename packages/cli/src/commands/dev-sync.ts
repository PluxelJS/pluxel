import { resolve } from 'node:path'
import { define, type ArgValues } from 'gunshi'
import { devSyncArgs, devSyncDefinition } from '../command-manifest'
import { validateCommandOptions } from '../command-options'
import { connectDevProject } from '../dev/project'
import { connectDevInstance } from '../dev/client'
import { syncPluginControl } from '../script/sync'
import { scriptFailure } from '@pluxel/host/agent'

export const devSyncCommand = define({
	...devSyncDefinition,
	async run(ctx) {
		try {
			validateCommandOptions(ctx)
			const values = ctx.values as ArgValues<typeof devSyncArgs>
			const instance = await connectDevProject(values)
			using connection = await connectDevInstance(instance)
			const out = values.out ? resolve(values.out) : resolve(instance.root, '.pluxel/control')
			const value = await syncPluginControl({
				source: {
					manifest: (input) => connection.materials(input),
					file: (input) => connection.materialFile(input),
				},
				out,
			})
			ctx.log(JSON.stringify({ ok: true, value }))
		} catch (error) {
			ctx.log(JSON.stringify({ ok: false, error: scriptFailure(error, 'control_sync_failed') }))
			process.exitCode = 1
		}
	},
})
