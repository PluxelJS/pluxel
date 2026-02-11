#!/usr/bin/env node
import { type Command, cli, type LazyCommand, lazy } from 'gunshi'
import pkg from '../package.json'
import { newCommand } from './scaffold'

type AnyCommand = Command<unknown> | LazyCommand<unknown>

const commands = new Map<string, AnyCommand>([
	['new', newCommand],
	[
		'build',
		lazy(() => import('./commands/build').then((m) => m.buildCommand), {
			name: 'build',
			description: 'Build current project',
		}),
	],
	[
		'publish',
		lazy(() => import('./commands/publish').then((m) => m.publishCommand), {
			name: 'publish',
			description: 'Publish plugin packages',
		}),
	],
	[
		'hmr',
		lazy(() => import('./commands/hmr').then((m) => m.hmrCommand), {
			name: 'hmr',
			description: 'Manage HMR workspace profiles and start HMR',
		}),
	],
	[
		'workspace',
		lazy(() => import('./commands/workspace').then((m) => m.workspaceCommand), {
			name: 'workspace',
			description: 'Manage workspaces (pnpm / yarn)',
		}),
	],
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
