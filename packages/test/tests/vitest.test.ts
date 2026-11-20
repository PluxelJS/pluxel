import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { createDiskFixture } from '@pluxel/test/fixtures'

it('keeps external CommonJS resolution native in a worker running the Pluxel preset', async () => {
	await using fixture = await createDiskFixture({
		node_modules: {
			'dual-format': {
				'package.json': JSON.stringify({
					name: 'dual-format',
					exports: { '.': { import: './import.mjs', require: './require.cjs' } },
				}),
				'import.mjs': "export default class Pool { mode = 'import' }",
				'require.cjs': "module.exports = class Pool { mode = 'require' }",
			},
		},
	})
	const require = createRequire(fixture.getPath('consumer.cjs'))
	const Pool = require('dual-format')
	class BoundPool extends Pool {}
	expect(new BoundPool().mode).toBe('require')
})
