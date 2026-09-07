import { describe, expect, it } from 'vitest'
import {
	CommandError,
	createCommandRegistry,
	defineCommand,
	type CommandContext,
} from '../src/index'
import { createArgvRouter } from '../src/argv'
import { Type, obj } from '../src/typebox'

type HostContext = CommandContext & {
	principal: { id: string; canWrite: boolean }
}

describe('@pluxel/commands host integration', () => {
	it('shares one validated command across filtered tools, registry dispatch, argv, and disposal', async () => {
		const reads: string[] = []
		const writes: string[] = []
		const readInput = obj({ name: Type.String() })
		const readOutput = obj({ owner: Type.String() })
		const read = defineCommand<typeof readInput, typeof readOutput, HostContext>({
			name: 'resource.read',
			description: 'Read one resource.',
			behavior: { kind: 'query', world: 'closed' },
			input: readInput,
			output: readOutput,
			execute({ name }, context) {
				reads.push(name)
				return { owner: context.principal.id }
			},
		})
		const writeInput = obj({ name: Type.String() })
		const write = defineCommand<typeof writeInput, HostContext>({
			name: 'resource.write',
			description: 'Write one resource.',
			behavior: { kind: 'mutation', destructive: false, idempotent: true, world: 'closed' },
			input: writeInput,
			execute({ name }) {
				writes.push(name)
			},
		})

		const registry = createCommandRegistry<HostContext>()
		const readRegistration = registry.register(read)
		const writeRegistration = registry.register(write)
		const router = createArgvRouter<HostContext>()
		const argvRegistration = router.bind(read, {
			routes: ['resource read'],
			positionals: ['name'],
		})
		const executeAsHost = async (name: string, input: unknown, context: HostContext) => {
			const descriptor = registry.list().find((candidate) => candidate.name === name)
			if (descriptor?.behavior.kind === 'mutation' && !context.principal.canWrite) {
				throw new CommandError('FORBIDDEN', 'Command is not allowed', {
					details: { permission: 'resource.write' },
				})
			}
			return registry.execute(name, input, context)
		}

		const published = registry.list().filter((descriptor) => descriptor.behavior.kind === 'query')
		expect(published.map(({ name }) => name)).toEqual(['resource.read'])

		const reader = { principal: { id: 'reader-1', canWrite: false } }
		const resolution = router.resolve(['resource', 'read', 'alpha'])!
		await expect(resolution.command.execute(resolution.candidate, reader)).resolves.toEqual({
			owner: 'reader-1',
		})
		await expect(executeAsHost('resource.write', { name: 'alpha' }, reader)).rejects.toMatchObject({
			code: 'FORBIDDEN',
			details: { permission: 'resource.write' },
		})

		const writer = { principal: { id: 'writer-1', canWrite: true } }
		await expect(
			registry.execute('resource.write', { name: 'alpha' }, writer),
		).resolves.toBeUndefined()
		expect(reads).toEqual(['alpha'])
		expect(writes).toEqual(['alpha'])

		argvRegistration.dispose()
		readRegistration.dispose()
		writeRegistration.dispose()
		expect(router.resolve(['resource', 'read', 'alpha'])).toBeUndefined()
		expect(registry.list()).toEqual([])
	})
})
