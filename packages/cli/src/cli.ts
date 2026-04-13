#!/usr/bin/env node
import { type Command, cli, define } from 'gunshi'
import pkg from '../package.json'
import { buildCommand } from './commands/build'
import { hmrCommand } from './commands/hmr'
import { publishCommand } from './commands/publish'
import { workspaceCommand } from './commands/workspace'
import { newCommand } from './scaffold'

type AnyCommand = Command

const commands = new Map<string, AnyCommand>([
	['new', newCommand],
	['build', buildCommand],
	['publish', publishCommand],
	['hmr', hmrCommand],
	['workspace', workspaceCommand],
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
		const msg = error instanceof Error ? error.message : String(error)
		process.stderr.write(`${msg}\n`)
		process.exitCode = 1
	}
}

void main()
