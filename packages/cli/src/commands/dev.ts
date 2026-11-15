import { type ArgValues, type CommandContext, define } from 'gunshi'
import { styleText } from 'node:util'
import { devCommandDefinition, devStatusDefinition } from '../command-manifest'
import {
	devCommonArgs,
	validateCommandOptions,
	printDevFailure,
	printValue,
} from '@pluxel/agent-sdk/internal/cli'
import {
	requireDevScripts,
	resolveDevSelection,
	DevClientError,
	type DevInstance,
	selectDevInstance,
	withDevContext,
} from '@pluxel/agent-sdk/internal/client'
import { listHosts } from '@pluxel/agent-sdk/client'
import { readDevService, startDevService } from '../dev/project'
import { runDevCommand } from '../dev/process'

type DevCommandContext = Pick<CommandContext, 'log'>

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

export const devCommand = define({
	...devCommandDefinition,
	async run(ctx) {
		try {
			await validateCommandOptions(ctx)
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

export const devStatusCommand = define({
	...devStatusDefinition,
	async run(ctx) {
		try {
			await validateCommandOptions(ctx)
			const selection = await resolveDevSelection(ctx.values as ArgValues<typeof devCommonArgs>)
			if (selection.project.scripts === false) {
				if (selection.instance !== undefined) requireDevScripts(selection.project)
				printValue(ctx.log, {
					workspace: selection.project.workspace,
					profile: selection.project.profile,
					root: selection.root,
					scripts: false,
					service: await readDevService(selection.project),
				})
				return
			}
			printValue(
				ctx.log,
				await listHosts({
					root: selection.project.profile ? selection.project.workspace : selection.root,
					profile: selection.project.profile,
					instance: selection.instance,
				}),
			)
		} catch (error) {
			await printDevFailure(ctx.log, error)
		}
	},
})
