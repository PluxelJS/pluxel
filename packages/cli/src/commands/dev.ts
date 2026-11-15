import { type ArgValues, type CommandContext, define } from 'gunshi'
import { styleText } from 'node:util'
import {
	devCommandDefinition,
	devCommonArgs,
	devHmrArgs,
	devHmrDefinition,
	devInstancesDefinition,
	devStatusDefinition,
	devRunArgs,
	devRunDefinition,
} from '../command-manifest'
import {
	requireDevScripts,
	resolveDevProject,
	resolveDevSelection,
	DevClientError,
	type DevInstance,
	parseInput,
	readBoundedFile,
	selectDevInstance,
	withDevContext,
} from '@pluxel/agent-sdk/internal/client'
import { readDevService, startDevService } from '../dev/project'
import { validateCommandOptions } from '../command-options'
import { runDevCommand } from '../dev/process'
import { HostClientError, listHosts, runScript, controlHmr } from '@pluxel/agent-sdk/client'
import { printFailure, printRun, printRunProgress, printValue } from '../script/output'

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

async function printResult<T>(
	ctx: DevCommandContext,
	action: () => Promise<T>,
	print: (value: T) => void = (value) => printValue(ctx.log, value),
) {
	try {
		validateCommandOptions(ctx)
		print(await action())
	} catch (error) {
		if (error instanceof HostClientError) {
			printFailure(ctx.log, error.failure, error.receipt)
			return
		}
		const failure = withDevContext(error, {})
		const context = failure.context

		printFailure(ctx.log, {
			code: failure.code,
			message: failure.message.slice(0, 8192),
			...(failure.runId ? { runId: failure.runId } : {}),
			...(context && Object.keys(context).length > 0 ? { context } : {}),
			...(failure.hint ? { hint: failure.hint } : {}),
			...(failure.candidates ? { candidates: failure.candidates } : {}),
		})
	}
}

export const devCommand = define({
	...devCommandDefinition,
	async run(ctx) {
		try {
			validateCommandOptions(ctx)
			const selection = await resolveDevSelection(ctx.values as ArgValues<typeof devCommonArgs>)
			const project = selection.project
			if (selection.instance !== undefined) requireDevScripts(project)
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
				if (project.scripts === false) {
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
								hint: 'Declare a named pluxel.dev profile with a command or pitchfork service in package.json, or start Vite with scripts enabled.',
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
						hint: 'Check scripts and host-vite, then restart the selected development server.',
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

export const devStatusCommand = define({
	...devStatusDefinition,
	async run(ctx) {
		await printResult(ctx, async () => {
			const selection = await resolveDevSelection(ctx.values as ArgValues<typeof devCommonArgs>)
			if (selection.project.scripts === false) {
				if (selection.instance !== undefined) requireDevScripts(selection.project)
				return {
					workspace: selection.project.workspace,
					profile: selection.project.profile,
					root: selection.root,
					scripts: false,
					service: await readDevService(selection.project),
				}
			}
			return listHosts({
				root: selection.project.profile ? selection.project.workspace : selection.root,
				profile: selection.project.profile,
				instance: selection.instance,
			})
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
