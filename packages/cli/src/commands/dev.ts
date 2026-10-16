import { type ArgValues, type CommandContext, define } from 'gunshi'
import { styleText } from 'node:util'
import {
	devCancelDefinition,
	devCommandDefinition,
	devCommonArgs,
	devInstancesDefinition,
	devStatusDefinition,
	devResultDefinition,
	devRunArgs,
	devRunDefinition,
	devReceiptArgs,
} from '../command-manifest'
import {
	DevClientError,
	liveDevInstances,
	matchesDevInstance,
	parseInput,
	parseRunSnapshot,
	publicInstance,
	readBoundedFile,
	requestDev,
	runDevFile,
	selectDevInstance,
	withDevContext,
	type DevInstance,
	type DevRunSnapshot,
} from '../dev/client'
import {
	connectDevProject,
	readDevService,
	requireDevConsole,
	resolveDevSelection,
	startDevService,
} from '../dev/project'
import { runDevCommand } from '../dev/process'
import { decodeDevReceipt, encodeDevReceipt } from '../dev/receipt'

type DevCommandContext = Pick<
	CommandContext,
	'args' | 'tokens' | 'log' | 'positionals' | 'commandPath'
>

function printDevHeading(
	ctx: DevCommandContext,
	profile: string | undefined,
	action: 'starting' | 'started' | 'reused' | 'not running',
): void {
	ctx.log(
		`  ${styleText('bold', 'Pluxel')}${profile ? ` · ${profile}` : ''} · ${styleText('dim', action)}`,
	)
	ctx.log('')
}

/** Style presentation text only; URL ownership and console data remain with Vite. */
function terminalUrl(line: string): string {
	return line.replace(
		/^(  )➜  ([A-Za-z]+:)(\s+)(https?:\/\/\S+)$/,
		(_, indent, label, spacing, url) =>
			`${indent}${styleText('green', '➜')}  ${styleText('bold', label)}${spacing}${styleText('cyan', url)}`,
	)
}

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
	const positionalCount = ctx.positionals.length
	const declaredPositionals = Object.values(ctx.args).filter(
		(arg) => arg.type === 'positional',
	).length
	if (positionalCount > ctx.commandPath.length + declaredPositionals)
		throw new DevClientError(
			'invalid_input',
			'Unexpected argument; check the selected dev command’s --help',
		)
}

function runReceipt(instance: DevInstance, runId: string): string {
	return encodeDevReceipt({
		root: instance.root,
		instanceId: instance.instanceId,
		runId,
		serviceId: instance.serviceId,
	})
}

function runResult(instance: DevInstance, snapshot: DevRunSnapshot) {
	return { ...snapshot, receipt: runReceipt(instance, snapshot.runId) }
}

async function printResult(
	ctx: DevCommandContext,
	action: () => Promise<unknown>,
	pendingExitCode = 2,
) {
	try {
		validateDevOptions(ctx)
		const value = await action()
		ctx.log(JSON.stringify({ ok: true, value }))
		if (value && typeof value === 'object' && 'state' in value) {
			if (value.state === 'failed' || value.state === 'cancelled') process.exitCode = 1
			else if (value.state !== 'succeeded') process.exitCode = pendingExitCode
		}
	} catch (error) {
		const failure = withDevContext(error, {})
		const context = failure.context
		const receipt =
			failure.runId && context?.root && context.instanceId
				? encodeDevReceipt({
						root: context.root,
						instanceId: context.instanceId,
						runId: failure.runId,
						serviceId: context.serviceId,
					})
				: undefined
		ctx.log(
			JSON.stringify({
				ok: false,
				error: {
					code: failure.code,
					message: failure.message.slice(0, 8192),
					...(failure.runId ? { runId: failure.runId } : {}),
					...(receipt ? { receipt } : {}),
					...(context && Object.keys(context).length > 0 ? { context } : {}),
					...(failure.hint ? { hint: failure.hint } : {}),
					...(failure.candidates ? { candidates: failure.candidates } : {}),
				},
			}),
		)
		process.exitCode = 1
	}
}

export const devCommand = define({
	...devCommandDefinition,
	async run(ctx) {
		try {
			validateDevOptions(ctx)
			const selection = await resolveDevSelection(ctx.values as ArgValues<typeof devCommonArgs>)
			const project = selection.project
			if (selection.instance !== undefined) requireDevConsole(project)
			let instance: DevInstance
			let action: 'started' | 'reused' = 'reused'
			if (project?.pitchfork && selection.instance === undefined) {
				const service = await readDevService(project)
				const code = await startDevService(project, service)
				if (code !== 0) {
					process.exitCode = code
					return
				}
				action = service.status === 'running' ? 'reused' : 'started'
				if (project.console === false) {
					const current = await readDevService(project)
					if (current.id !== service.id)
						throw new DevClientError(
							'service_unavailable',
							'Pitchfork service identity changed during startup.',
						)
					printDevHeading(
						ctx,
						project.profile,
						current.status === 'running' ? action : 'not running',
					)
					ctx.log(`  ➜  Service: ${current.id} (${current.status})`)
					const url = current.url ?? current.proxy_url
					if (url) ctx.log(terminalUrl(`  ➜  URL:     ${url}`))
					if (current.status !== 'running') process.exitCode = 2
					return
				}
				instance = await selectDevInstance({ root: project.root, serviceId: service.id })
			} else {
				try {
					instance = await selectDevInstance(selection)
				} catch (error) {
					if (
						!(error instanceof DevClientError) ||
						error.code !== 'dev_unavailable' ||
						selection.instance !== undefined
					)
						throw error
					if (!project?.command)
						throw new DevClientError(
							'invalid_project',
							'No running console or development command was found.',
							{
								hint: 'Declare a named pluxel.dev profile with a command or pitchfork service in package.json, or start Vite with devConsole enabled.',
							},
						)
					// The foreground process owns startup output, keyboard shortcuts and its lifetime.
					printDevHeading(ctx, project.profile, 'starting')
					process.exitCode = await runDevCommand(
						project.command,
						project.workspace,
						project.profile,
					)
					return
				}
			}
			if (!instance.urlOutput?.length)
				throw new DevClientError(
					'dev_unavailable',
					'The selected Vite instance has no URL presentation.',
					{
						hint: 'Check devConsole and host-vite, then restart the selected development server.',
					},
				)
			printDevHeading(ctx, project.profile, action)
			for (const line of instance.urlOutput) ctx.log(terminalUrl(line))
			if (instance.application?.state !== 'ready') {
				ctx.log(
					styleText(
						instance.application?.state === 'updating' ? 'yellow' : 'red',
						`[pluxel] Application: ${instance.application?.state ?? 'unknown'}; use dev status with the same project selection for details.`,
					),
				)
				if (instance.application?.state !== 'updating') process.exitCode = 2
			}
		} catch (error) {
			const failure = withDevContext(error, {})
			ctx.log(`[pluxel] ${failure.code}: ${failure.message}`)
			if (failure.hint) ctx.log(failure.hint)
			if (failure.candidates) ctx.log(JSON.stringify(failure.candidates))
			process.exitCode = 1
		}
	},
})

export const devInstancesCommand = define({
	...devInstancesDefinition,
	async run(ctx) {
		await printResult(ctx, async () => {
			const selection = await resolveDevSelection(ctx.values as ArgValues<typeof devCommonArgs>)
			requireDevConsole(selection.project)
			const instances = await liveDevInstances(selection.root)
			return instances
				.filter((instance) => matchesDevInstance(instance, selection))
				.map(publicInstance)
		})
	},
})

export const devStatusCommand = define({
	...devStatusDefinition,
	async run(ctx) {
		await printResult(ctx, async () => {
			const selection = await resolveDevSelection(ctx.values as ArgValues<typeof devCommonArgs>)
			if (selection.project.console === false) {
				if (selection.instance !== undefined) requireDevConsole(selection.project)
				return {
					workspace: selection.project.workspace,
					profile: selection.project.profile,
					root: selection.root,
					console: false,
					service: await readDevService(selection.project),
				}
			}
			const live = await liveDevInstances(selection.root)
			const instances = live.filter((instance) => matchesDevInstance(instance, selection))
			return {
				...(selection.project ? { workspace: selection.project.workspace } : {}),
				...(selection.project.profile ? { profile: selection.project.profile } : {}),
				root: selection.root,
				instances: instances.map(publicInstance),
			}
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
				const instance = await connectDevProject(values)
				const result = await runDevFile({
					instance,
					file: values.file,
					exportName: values.export,
					input,
					timeoutMs: Number(values.timeout),
					detach: values.detach,
					onAccepted: (snapshot) => {
						process.stderr.write(
							JSON.stringify({
								event: 'accepted',
								root: snapshot.root,
								runId: snapshot.runId,
								instanceId: snapshot.instanceId,
								receipt: runReceipt(instance, snapshot.runId),
								state: snapshot.state,
							}) + '\n',
						)
					},
				})
				return runResult(instance, result)
			},
			values.detach ? 0 : 2,
		)
	},
})

async function receiptResult(ctx: DevCommandContext, token: string, method: 'result' | 'cancel') {
	await printResult(ctx, async () => {
		const receipt = decodeDevReceipt(token)
		try {
			const instance = await selectDevInstance({
				root: receipt.root,
				instance: receipt.instanceId,
				serviceId: receipt.serviceId,
			})
			const snapshot = parseRunSnapshot(
				await requestDev(instance, { method, runId: receipt.runId }),
				instance,
				receipt.runId,
			)
			return runResult(instance, snapshot)
		} catch (error) {
			throw withDevContext(error, receipt, receipt.runId)
		}
	})
}

export const devResultCommand = define({
	...devResultDefinition,
	async run(ctx) {
		await receiptResult(ctx, (ctx.values as ArgValues<typeof devReceiptArgs>).receipt, 'result')
	},
})
export const devCancelCommand = define({
	...devCancelDefinition,
	async run(ctx) {
		await receiptResult(ctx, (ctx.values as ArgValues<typeof devReceiptArgs>).receipt, 'cancel')
	},
})
