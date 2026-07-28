import { createCommandRegistry, defineCommand } from '../src'
import { createCommandArgv } from '../src/argv'
import { Type, obj } from '../src/typebox'
import { describe, expect, it } from 'vitest'

function patchCommand(version: string) {
	return defineCommand({
		name: 'config.patch',
		description: 'Patch one plugin configuration.',
		behavior: { kind: 'mutation', destructive: false, idempotent: true, world: 'closed' },
		input: obj({
			name: Type.String(),
			patch: Type.Record(Type.String(), Type.Unknown()),
		}),
		output: obj({ version: Type.String(), name: Type.String(), enabled: Type.Boolean() }),
		execute: ({ name, patch }) => ({
			version,
			name,
			enabled: patch.enabled === true,
		}),
	})
}

describe('automatic command argv projection', () => {
	it('uses the command name, generated scalar options, and field-level JSON', async () => {
		const registry = createCommandRegistry()
		registry.register(patchCommand('v1'))
		const argv = createCommandArgv(registry)

		await expect(
			argv.dispatchOrThrow([
				'config.patch',
				'--name',
				'CachePlugin',
				'--patch',
				'{"enabled":true}',
			]),
		).resolves.toEqual({ version: 'v1', name: 'CachePlugin', enabled: true })

		expect(argv.help('config.patch')).toMatchObject({
			name: 'config.patch',
			routes: ['config.patch'],
			parameters: [
				{ key: 'name', kind: 'option', type: 'string', required: true },
				{ key: 'patch', kind: 'option', type: 'json', required: true },
			],
		})
	})

	it('resolves the current registered handle after replacement', async () => {
		const registry = createCommandRegistry()
		const first = registry.register(patchCommand('v1'))
		const argv = createCommandArgv(registry)
		await expect(
			argv.dispatchOrThrow(`config.patch --name CachePlugin --patch '{"enabled":false}'`),
		).resolves.toMatchObject({ version: 'v1' })

		first.dispose()
		registry.register(patchCommand('v2'))
		await expect(
			argv.dispatchOrThrow(`config.patch --name CachePlugin --patch '{"enabled":false}'`),
		).resolves.toMatchObject({ version: 'v2' })
	})

	it('returns bounded command-name suggestions from the current catalog', async () => {
		const registry = createCommandRegistry()
		registry.register(patchCommand('v1'))
		const argv = createCommandArgv(registry)

		await expect(argv.dispatchOrThrow('config.patc')).rejects.toMatchObject({
			code: 'COMMAND_NOT_FOUND',
			details: { name: 'config.patc', suggestions: ['config.patch'] },
		})
	})
})
