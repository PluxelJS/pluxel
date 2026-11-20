import { cancelScript, getScriptResult, runScript } from '@pluxel/agent-sdk/client'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'
import { startProjectScriptServer } from '../src/console/server'

it('cancels an admitted local script by its receipt and reports when it has actually settled', async () => {
	await using fixture = await createDiskFixture({
		'package.json': '{}',
		'operation.ts': 'export default () => null',
	})
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const server = await startProjectScriptServer({
		root: fixture.path,
		async execute(_input, { signal }) {
			entered.resolve()
			await release.promise
			signal.throwIfAborted()
		},
	})
	try {
		const { receipt } = await runScript({
			target: { root: fixture.path },
			file: fixture.getPath('operation.ts'),
			detach: true,
		})
		await entered.promise
		await expect(cancelScript(receipt)).resolves.toMatchObject({
			receipt,
			run: { state: 'cancelling' },
		})
		await expect(getScriptResult(receipt)).resolves.toMatchObject({
			run: { state: 'cancelling' },
		})
		release.resolve()
		await expect
			.poll(() => getScriptResult(receipt))
			.toMatchObject({
				run: { state: 'cancelled', error: { code: 'cancelled' } },
			})
	} finally {
		release.resolve()
		await server.close()
	}
})
