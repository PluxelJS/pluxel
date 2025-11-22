#!/usr/bin/env node
import { type Command, cli, type LazyCommand } from 'gunshi'
import pkg from '../package.json'
import { buildCommand, publishCommand, workspaceCommand } from './commands'
import { newCommand } from './plop'

type AnyCommand = Command<any> | LazyCommand<any>

const commands = new Map<string, AnyCommand>([
	['new', newCommand],
	['build', buildCommand],
	['publish', publishCommand],
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
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	}
}

void main()
