#!/usr/bin/env node
import { cli, define, lazy } from 'gunshi'
import pkg from '../package.json'
import {
	buildCommandDefinition,
	databaseCommandDefinition,
	distributionCommandDefinition,
	hmrCommandDefinition,
	newCommandDefinition,
	publishCommandDefinition,
	sourceCommandDefinition,
	workspaceCommandDefinition,
} from './command-manifest'
import { formatOfficialCapabilityError, OfficialCapabilityError } from './capability-loader'

const commands = new Map([
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
		'hmr',
		lazy(() => import('./commands/hmr').then((module) => module.hmrCommand), hmrCommandDefinition),
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
	try {
		const argv = process.argv.slice(2)
		const nextArgv = argv.length === 0 ? ['--help'] : argv
		await cli(nextArgv, rootCommand, {
			name: pkg.name ?? 'pluxel',
			version: pkg.version,
			subCommands: commands,
		})
	} catch (error) {
		const msg = formatCliError(error, process.argv[2])
		process.stderr.write(`${msg}\n`)
		process.exitCode = 1
	}
}

function formatCliError(error: unknown, command: string | undefined): string {
	if (error instanceof OfficialCapabilityError) return formatOfficialCapabilityError(error)
	const message = error instanceof Error ? error.message : String(error)
	return message
}

await main()
