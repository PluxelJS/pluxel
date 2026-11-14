#!/usr/bin/env node
import { cli, define, lazy, type SubCommandable } from 'gunshi'
import pkg from '../package.json'
import { renderCliHeader } from './render-header'
import {
	buildCommandDefinition,
	databaseCommandDefinition,
	devCommandDefinition,
	distributionCommandDefinition,
	docsCommandDefinition,
	isControlCommandPath,
	newCommandDefinition,
	normalizeDevArgs,
	publishCommandDefinition,
	sourceCommandDefinition,
	scriptCommandDefinition,
	workspaceCommandDefinition,
} from './command-manifest'
import { printFailure } from './script/output'

const commands = new Map<string, SubCommandable>([
	[
		'script',
		lazy(
			() => import('./commands/script').then((module) => module.scriptCommand),
			scriptCommandDefinition,
		),
	],
	[
		'pncat',
		define({ name: 'pncat', description: 'Run the bundled pncat CLI with its native arguments' }),
	],
	[
		'dev',
		lazy(() => import('./commands/dev').then((module) => module.devCommand), devCommandDefinition),
	],
	[
		'docs',
		lazy(
			() => import('./commands/docs').then((module) => module.docsCommand),
			docsCommandDefinition,
		),
	],
	[
		'new',
		lazy(() => import('./scaffold').then((module) => module.newCommand), newCommandDefinition),
	],
	[
		'build',
		lazy(
			() => import('./commands/build').then((module) => module.buildCommand),
			buildCommandDefinition,
		),
	],
	[
		'database',
		lazy(
			() => import('./commands/database').then((module) => module.databaseCommand),
			databaseCommandDefinition,
		),
	],
	[
		'distribution',
		lazy(
			() => import('./commands/distribution').then((module) => module.distributionCommand),
			distributionCommandDefinition,
		),
	],
	[
		'publish',
		lazy(
			() => import('./commands/publish').then((module) => module.publishCommand),
			publishCommandDefinition,
		),
	],
	[
		'source',
		lazy(
			() => import('./commands/source').then((module) => module.sourceCommand),
			sourceCommandDefinition,
		),
	],
	[
		'workspace',
		lazy(
			() => import('./commands/workspace').then((module) => module.workspaceCommand),
			workspaceCommandDefinition,
		),
	],
])

const rootCommand = define({
	name: pkg.name ?? 'pluxel',
	description: 'Pluxel CLI',
	args: {},
	async run() {
		// Keep root command empty; actual behavior lives in subcommands.
	},
})

async function main() {
	let failureReported = false
	try {
		const argv = process.argv.slice(2)
		if (argv[0] === 'pncat') {
			const { runPncat } = await import('./commands/pncat')
			await runPncat(argv.slice(1))
			return
		}
		const nextArgv = argv.length === 0 ? ['--help'] : argv
		await cli(normalizeDevArgs(nextArgv), rootCommand, {
			name: pkg.name ?? 'pluxel',
			version: pkg.version,
			renderHeader: renderCliHeader,
			subCommands: commands,
			onBeforeCommand(ctx) {
				// Run before Gunshi's global decorator renders validation errors on stdout.
				if (
					isControlCommandPath(ctx.commandPath) &&
					!ctx.values.help &&
					!ctx.values.version &&
					ctx.validationError
				)
					throw ctx.validationError
			},
			async onErrorCommand(ctx, error) {
				if (!isControlCommandPath(ctx.commandPath) || ctx.values.help || ctx.values.version) return
				const { scriptFailure } = await import('@pluxel/host/agent/runtime')
				printFailure(
					ctx.log,
					scriptFailure(error, error === ctx.validationError ? 'invalid_input' : 'command_failed'),
				)
				failureReported = true
			},
		})
	} catch (error) {
		if (failureReported) return
		const msg = error instanceof Error ? error.message : String(error)
		process.stderr.write(`${msg}\n`)
		process.exitCode = 1
	}
}

await main()
