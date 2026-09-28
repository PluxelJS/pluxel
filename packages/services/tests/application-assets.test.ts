import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveApplicationAsset } from '../src/elysia/assets'

describe('application static assets', () => {
	it('uses HTML fallback only for missing navigation files', async () => {
		const publicDir = await mkdtemp(join(tmpdir(), 'pluxel-static-'))
		try {
			await writeFile(join(publicDir, 'index.html'), '<main>ready</main>')
			const missing = await resolveApplicationAsset(
				new Request('http://app.test/missing.js'),
				publicDir,
			)
			expect(missing).toBeNull()
			const page = await resolveApplicationAsset(
				new Request('http://app.test/missing', { headers: { accept: 'text/html' } }),
				publicDir,
			)
			expect(await page?.text()).toBe('<main>ready</main>')
			await symlink('loop', join(publicDir, 'loop'))
			const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
			try {
				const failure = await resolveApplicationAsset(
					new Request('http://app.test/loop', { headers: { accept: 'text/html' } }),
					publicDir,
				)
				expect(failure?.status).toBe(500)
				expect(logged.mock.calls[0]?.[0]).toEqual(
					expect.objectContaining({
						message: expect.stringContaining('Cannot stat application asset'),
					}),
				)
				await writeFile(join(publicDir, 'private.js'), 'secret')
				await chmod(join(publicDir, 'private.js'), 0)
				const unreadable = await resolveApplicationAsset(
					new Request('http://app.test/private.js'),
					publicDir,
				)
				expect(unreadable?.status).toBe(500)
				expect(logged.mock.calls[1]?.[0]).toEqual(
					expect.objectContaining({
						message: expect.stringContaining('Cannot open application asset'),
					}),
				)
			} finally {
				logged.mockRestore()
			}
		} finally {
			await rm(publicDir, { recursive: true, force: true })
		}
	})
})
