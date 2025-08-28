#!/usr/bin/env node
import { Command } from 'commander'
import { buildCommand } from './commands'
import { newCommand } from './plop'

const program = new Command().name('pluxel').description('My all-in-one CLI').version('0.1.0')

program.addCommand(newCommand())
program.addCommand(buildCommand())

program.parseAsync(process.argv).catch((e) => {
	console.error(e instanceof Error ? e.message : e)
	process.exit(1)
})
