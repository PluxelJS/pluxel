import { type ArgValues, define } from 'gunshi'
import { publishPackage } from '../publish'

const publishArgs = {
	access: {
		type: 'string',
		description: 'npm publish --access value',
		default: 'public',
	},
	dryRun: {
		type: 'boolean',
		description: 'Plan publish without executing',
		default: false,
	},
	debug: {
		type: 'boolean',
		description: 'Print npm args/env keys before running publish',
		default: false,
	},
	skipVersionCheck: {
		type: 'boolean',
		description: 'Skip checking if version already published',
		default: false,
	},
} as const

type PublishArgs = typeof publishArgs
type PublishValues = ArgValues<PublishArgs>

export const publishCommand = define({
	name: 'publish',
	description: 'Publish current package to npm and notify market',
	args: publishArgs,
	async run(ctx) {
		const values = ctx.values as PublishValues
		await publishPackage({
			access: values.access,
			dryRun: values.dryRun,
			debug: values.debug,
			skipVersionCheck: values.skipVersionCheck,
			log: ctx.log,
		})
	},
})
