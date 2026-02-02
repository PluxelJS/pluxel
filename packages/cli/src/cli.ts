#!/usr/bin/env node
import { type Command, cli, type LazyCommand } from 'gunshi'
import pkg from '../package.json'
import { buildCommand, hmrCommand, publishCommand, workspaceCommand } from './commands'
import { newCommand } from './plop'

type AnyCommand = Command<any> | LazyCommand<any>

const commands = new Map<string, AnyCommand>([
	['new', newCommand],
	['build', buildCommand],
	['publish', publishCommand],
	['hmr', hmrCommand],
	['workspace', workspaceCommand],
])

async function main() {
	try {
		await cli(process.argv.slice(2), newCommand, {
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
