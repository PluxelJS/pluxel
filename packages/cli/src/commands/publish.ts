import { type ArgValues, define } from 'gunshi'
import { publishCommandArgs, publishCommandDefinition } from '../command-manifest'
import { publishPackage } from '../publish'

type PublishArgs = typeof publishCommandArgs
type PublishValues = ArgValues<PublishArgs>

export const publishCommand = define({
	...publishCommandDefinition,
	async run(ctx) {
		const values = ctx.values as PublishValues
		await publishPackage({
			access: values.access,
			dryRun: values['dry-run'],
			debug: values.debug,
			webhook: values.webhook,
			skipVersionCheck: values['skip-version-check'],
			log: ctx.log,
		})
	},
})
