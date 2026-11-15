import { type ArgValues, type CommandContext, define } from 'gunshi'
import {
	devCommonArgs,
	devHmrArgs,
	devHmrDefinition,
	devInstancesDefinition,
	devRunArgs,
	devRunDefinition,
} from './manifest'
import { DevClientError, parseInput, readBoundedFile } from '../client/dev'
import { resolveDevProject } from '../client/project'
import { listHosts, runScript, controlHmr } from '../client'
import { validateCommandOptions } from './options'
import { printDevFailure, printRun, printRunProgress, printValue } from './output'

type DevCommandContext = Pick<
	CommandContext,
	'args' | 'tokens' | 'log' | 'positionals' | 'commandPath'
>

async function printResult<T>(
	ctx: DevCommandContext,
	action: () => Promise<T>,
	print: (value: T) => void = (value) => printValue(ctx.log, value),
) {
	try {
		await validateCommandOptions(ctx)
		print(await action())
	} catch (error) {
		await printDevFailure(ctx.log, error)
	}
}

export const devInstancesCommand = define({
	...devInstancesDefinition,
	async run(ctx) {
		await printResult(ctx, async () => {
			const values = ctx.values as ArgValues<typeof devCommonArgs>
			const project = await resolveDevProject(values)
			const discovery = await listHosts({
				root: values.root ?? project.workspace,
				profile: values.profile,
				instance: values.instance,
			})
			return discovery.instances
		})
	},
})

export const devRunCommand = define({
	...devRunDefinition,
	async run(ctx) {
		const values = ctx.values as ArgValues<typeof devRunArgs>
		await printResult(
			ctx,
			async () => {
				if (values.input !== undefined && values['input-file'] !== undefined)
					throw new DevClientError('invalid_input', 'Use either --input or --input-file')
				const buffer =
					values['input-file'] === undefined
						? undefined
						: await readBoundedFile(values['input-file'])
				const source = buffer === undefined ? values.input : buffer.toString('utf8')
				const input = source === undefined ? undefined : parseInput(source)
				const project = await resolveDevProject(values)
				return runScript({
					target: {
						root: values.root ?? project.workspace,
						profile: values.profile,
						instance: values.instance,
					},
					file: values.file,
					exportName: values.export,
					input,
					timeoutMs: Number(values.timeout),
					detach: values.detach,
					onPrepared: (receipt) => printRunProgress('prepared', receipt),
					onAccepted: ({ receipt }) => printRunProgress('accepted', receipt),
				})
			},
			(value) => printRun(ctx.log, value.receipt, value.run, values.detach),
		)
	},
})

export const devHmrCommand = define({
	...devHmrDefinition,
	async run(ctx) {
		const values = ctx.values as ArgValues<typeof devHmrArgs>
		await printResult(
			ctx,
			async () => {
				if (values.action !== 'pause' && values.action !== 'apply' && values.action !== 'resume')
					throw new DevClientError('invalid_input', 'Expected HMR action pause, apply or resume')
				const project = await resolveDevProject(values)
				return controlHmr({
					target: {
						root: values.root ?? project.workspace,
						profile: values.profile,
						instance: values.instance,
					},
					action: values.action,
					timeoutMs: Number(values.timeout),
					detach: values.detach,
					onPrepared: (receipt) => printRunProgress('prepared', receipt),
					onAccepted: ({ receipt }) => printRunProgress('accepted', receipt),
				})
			},
			(value) => printRun(ctx.log, value.receipt, value.run, values.detach),
		)
	},
})
