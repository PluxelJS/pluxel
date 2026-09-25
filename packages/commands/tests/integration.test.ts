import { expect, it } from 'vitest'
import { createCommandRegistry, defineCommand, Result } from '../src/index'
import { Type, obj } from '../src/typebox'
import { createArgvRouter } from '../src/argv'

it('shares one input boundary across direct, registry, and argv calls', async () => {
	const command = defineCommand({
		name: 'number.double',
		description: 'Double a number.',
		input: obj({ number: Type.Number() }),
		execute({ number }) {
			return Result.ok(number * 2)
		},
	})
	const registry = createCommandRegistry()
	using registration = registry.register(command)
	const router = createArgvRouter()
	router.bind(registration, { routes: ['double'], positionals: ['number'] })
	const candidate = router.resolve('double 3')!.candidate
	const results = await Promise.all([
		command.execute({ number: 3 }),
		registration.execute({ number: 3 }),
		registry.execute('number.double', candidate),
		router.resolve('double 3')!.command.execute(candidate),
	])
	expect(results.map((result) => (result.isOk() ? result.value : result.error))).toEqual([
		6, 6, 6, 6,
	])
})
