import { define } from 'gunshi'

export const buildCommand = define({
	name: 'build',
	description: 'Build current project',
	args: {
		watch: {
			type: 'boolean',
			description: 'Enable watch mode',
			default: false,
		},
	},
	async run(ctx) {
		const { watch } = ctx.values
		// TODO: wire up real build pipeline here
		ctx.log('building...', { watch })
	},
})
