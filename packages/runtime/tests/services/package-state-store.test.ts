import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { resolve } from 'pathe'

import { PackageStateStore } from '../../../runtime-loader/src/package/state-store'

describe('PackageStateStore', () => {
	it('treats unsupported schema as a cache miss (no legacy migrations)', async () => {
		await using fixture = await createFixture({
			'state.json': JSON.stringify(
				{ schema: 999, generatedAt: 'now', packages: [], issues: [] },
				null,
				2,
			),
		})

		const file = resolve(fixture.path, 'state.json')
		const store = new PackageStateStore({
			file,
			fs: {
				readText: async (p) => await fixture.fsp.readFile(p, 'utf8'),
				writeTextAtomic: async (p, data) => void (await fixture.fsp.writeFile(p, data, 'utf8')),
			},
		})

		const out = await store.read()
		expect(out).toBeNull()
	})
})
