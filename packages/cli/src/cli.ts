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
	newCommandDefinition,
	publishCommandDefinition,
	sourceCommandDefinition,
	workspaceCommandDefinition,
} from './command-manifest'

const commands = new Map<string, SubCommandable>([
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
	try {
		const argv = process.argv.slice(2)
		const nextArgv = argv.length === 0 ? ['--help'] : argv
		await cli(nextArgv, rootCommand, {
			name: pkg.name ?? 'pluxel',
			version: pkg.version,
			renderHeader: renderCliHeader,
			subCommands: commands,
		})
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		process.stderr.write(`${msg}\n`)
		process.exitCode = 1
	}
}

await main()
