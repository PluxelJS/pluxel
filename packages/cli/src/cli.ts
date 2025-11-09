#!/usr/bin/env node
import { cli } from 'gunshi'
import pkg from '../package.json' 
import { buildCommand } from './commands'
import { newCommand } from './plop'

const commands = new Map([
	['new', newCommand],
	['build', buildCommand],
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
