import { type ArgValues, type CommandContext, define } from 'gunshi'
import {
	devCancelDefinition,
	devCommandDefinition,
	devInstancesArgs,
	devInstancesDefinition,
	devResultDefinition,
	devRunArgs,
	devRunDefinition,
	devRunIdArgs,
} from '../command-manifest'
import {
	DevClientError,
	liveDevInstances,
	parseInput,
	parseRunSnapshot,
	publicInstance,
	readBoundedFile,
	requestDev,
	resolveDevRoot,
	runDevFile,
	selectDevInstance,
	withDevContext,
	type DevErrorContext,
} from '../dev/client'

type DevCommandContext = Pick<CommandContext, 'args' | 'tokens' | 'log'>

function validateDevOptions(ctx: DevCommandContext): void {
	const allowed = new Set(['help', 'version'])
	const short = new Set(['h', 'v'])
	for (const [name, argument] of Object.entries(ctx.args)) {
		if (argument.type === 'positional') continue
		allowed.add(name)
		if (argument.short) short.add(argument.short)
		if (argument.type === 'boolean' && argument.negatable) allowed.add(`no-${name}`)
	}
	for (const token of ctx.tokens) {
		if (token.kind !== 'option') continue
		const names = token.rawName?.startsWith('--') ? allowed : short
		if (token.name && names.has(token.name)) continue
		throw new DevClientError(
			'invalid_input',
			`Unknown dev option ${token.rawName ?? token.name ?? '(unnamed)'}.`,
			{
				hint: 'Check the selected dev command’s --help for supported options.',
			},
		)
	}
}

async function printResult(
	ctx: DevCommandContext,
	action: (root: string) => Promise<unknown>,
	options: { root?: string; instance?: string; runId?: string; pendingExitCode?: number } = {},
) {
	const log = ctx.log
	let context: DevErrorContext = options.instance ? { instanceId: options.instance } : {}
	try {
		const root = await resolveDevRoot(options.root)
		context = { ...context, root }
		validateDevOptions(ctx)
		const value = await action(root)
		log(JSON.stringify({ ok: true, value }))
		if (value && typeof value === 'object' && 'state' in value) {
			if (value.state === 'failed' || value.state === 'cancelled') process.exitCode = 1
			else if (value.state !== 'succeeded') process.exitCode = options.pendingExitCode ?? 2
		}
	} catch (error) {
		const failure = withDevContext(error, context, options.runId)
		log(
			JSON.stringify({
				ok: false,
				error: {
					code: failure.code,
					message: failure.message.slice(0, 8192),
					...(failure.runId ? { runId: failure.runId } : {}),
					...(failure.context && Object.keys(failure.context).length > 0
						? { context: failure.context }
						: {}),
					...(failure.hint ? { hint: failure.hint } : {}),
					...(failure.candidates ? { candidates: failure.candidates } : {}),
				},
			}),
		)
		process.exitCode = 1
	}
}

export const devInstancesCommand = define({
	...devInstancesDefinition,
	async run(ctx) {
		const values = ctx.values as ArgValues<typeof devInstancesArgs>
		await printResult(
			ctx,
			async (root) => {
				const instances = await liveDevInstances(root)
				return instances.map(publicInstance)
			},
			values,
		)
	},
})

export const devRunCommand = define({
	...devRunDefinition,
	async run(ctx) {
		const values = ctx.values as ArgValues<typeof devRunArgs>
		await printResult(
			ctx,
			async (root) => {
				if (values.input !== undefined && values['input-file'] !== undefined)
					throw new DevClientError('invalid_input', 'Use either --input or --input-file')
				const buffer =
					values['input-file'] === undefined
						? undefined
						: await readBoundedFile(values['input-file'])
				const source = buffer === undefined ? values.input : buffer.toString('utf8')
				return runDevFile({
					root,
					instance: values.instance,
					file: values.file,
					exportName: values.export,
					input: source === undefined ? undefined : parseInput(source),
					timeoutMs: Number(values.timeout),
					detach: values.detach,
					onAccepted: (snapshot) => {
						process.stderr.write(
							JSON.stringify({
								event: 'accepted',
								root: snapshot.root,
								runId: snapshot.runId,
								instanceId: snapshot.instanceId,
								state: snapshot.state,
							}) + '\n',
						)
					},
				})
			},
			{ ...values, pendingExitCode: values.detach ? 0 : 2 },
		)
	},
})

export const devResultCommand = define({
	...devResultDefinition,
	async run(ctx) {
		const values = ctx.values as ArgValues<typeof devRunIdArgs>
		await printResult(
			ctx,
			async (root) => {
				const instance = await selectDevInstance({ root, instance: values.instance })
				return parseRunSnapshot(
					await requestDev(instance, { method: 'result', runId: values.id }),
					instance,
					values.id,
				)
			},
			{ ...values, runId: values.id },
		)
	},
})

export const devCancelCommand = define({
	...devCancelDefinition,
	async run(ctx) {
		const values = ctx.values as ArgValues<typeof devRunIdArgs>
		await printResult(
			ctx,
			async (root) => {
				const instance = await selectDevInstance({ root, instance: values.instance })
				return parseRunSnapshot(
					await requestDev(instance, { method: 'cancel', runId: values.id }),
					instance,
					values.id,
				)
			},
			{ ...values, runId: values.id },
		)
	},
})

export const devCommand = define({ ...devCommandDefinition, async run() {} })
