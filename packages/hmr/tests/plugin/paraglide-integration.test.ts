import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { join } from 'pathe'

import {
	isParaglideGeneratedFile,
	PLUXEL_PARAGLIDE_MESSAGES_DIR,
	PLUXEL_PARAGLIDE_OUTDIR,
	PLUXEL_PARAGLIDE_PROJECT_FILE,
	resolveParaglideIntegrationWithFs,
} from '../../src/paraglide'

describe('paraglide integration', () => {
	it('returns null when the plugin package has no inlang project', async () => {
		await using fixture = await createFixture({
			src: {
				ui: {
					'index.tsx': 'export default null',
				},
			},
		})

		expect(resolveParaglideIntegrationWithFs(fixture.path, fixture.fs)).toBeNull()
	})

	it('detects the default project/messages/outdir convention', async () => {
		await using fixture = await createFixture({
			[PLUXEL_PARAGLIDE_PROJECT_FILE]: '{}',
			[PLUXEL_PARAGLIDE_MESSAGES_DIR]: {
				'en.json': '{}',
			},
			src: {
				ui: {
					'index.tsx': 'export default null',
				},
			},
		})

		const resolved = resolveParaglideIntegrationWithFs(fixture.path, fixture.fs)
		expect(resolved).toMatchObject({
			project: `./${PLUXEL_PARAGLIDE_PROJECT_FILE}`,
			outdir: `./${PLUXEL_PARAGLIDE_OUTDIR}`,
			projectFile: join(fixture.path, PLUXEL_PARAGLIDE_PROJECT_FILE),
			outdirFile: join(fixture.path, PLUXEL_PARAGLIDE_OUTDIR),
			sourceRoots: [
				join(fixture.path, PLUXEL_PARAGLIDE_PROJECT_FILE),
				join(fixture.path, PLUXEL_PARAGLIDE_MESSAGES_DIR),
			],
		})
		expect(resolved?.plugins.length).toBeGreaterThan(0)
	})

	it('treats generated paraglide output as non-source input', async () => {
		await using fixture = await createFixture({
			[PLUXEL_PARAGLIDE_PROJECT_FILE]: '{}',
			src: {
				paraglide: {
					'messages.js': 'export const m = {}',
				},
			},
		})

		const resolved = resolveParaglideIntegrationWithFs(fixture.path, fixture.fs)
		expect(
			isParaglideGeneratedFile(
				resolved,
				join(fixture.path, PLUXEL_PARAGLIDE_OUTDIR, 'messages.js'),
			),
		).toBe(true)
		expect(
			isParaglideGeneratedFile(
				resolved,
				join(fixture.path, PLUXEL_PARAGLIDE_MESSAGES_DIR, 'en.json'),
			),
		).toBe(false)
	})
})
