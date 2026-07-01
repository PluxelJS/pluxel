import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { resolve } from 'pathe'
import { createMemoryPersistenceBackend } from '@pluxel/runtime'

import { PackageStateStore } from '../../src/package/state-store'

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
		const storage = createMemoryPersistenceBackend().namespace('package-state-test')
		const store = new PackageStateStore({
			file,
			storage,
		})
		await storage.put(file, await fixture.fsp.readFile(file, 'utf8'))

		const out = await store.read()
		expect(out).toBeNull()
	})
})
