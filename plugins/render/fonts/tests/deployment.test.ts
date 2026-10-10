import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	defineHostApplication,
	envBinding,
	fileBinding,
	resolveHostApplication,
} from '@pluxel/host'
import { createTestHost } from '@pluxel/test'
import { pluginNodeAddressOf } from '@pluxel/core'
import { describe, expect, it } from 'vitest'
import { FontsConfig, FontsPlugin } from '../src/index.ts'

const fontPath = [
	'/usr/share/fonts/dejavu/DejaVuSans.ttf',
	'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
	'/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
	'/System/Library/Fonts/Supplemental/Arial.ttf',
	process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'arial.ttf') : '',
].find((path) => path && existsSync(path))

describe('Fonts deployment without Workbench', () => {
	it('runs its core capability with no services and explicitly rejects persistence mutations', async () => {
		await using host = await createTestHost({ services: [] })
		await host.start(FontsPlugin, { initialConfig: { defaultFamily: 'serif' } })
		const fonts = host.require(FontsPlugin)
		expect(fonts.ctx.workbench).toBeUndefined()
		expect(fonts.ctx.root.persistence).toBeUndefined()
		expect(fonts.defaultFont).toMatchObject({ family: 'serif', source: 'config' })
		expect(fonts.portableFonts.fonts).toEqual([])
		await expect(fonts.setPreferredFamily('monospace')).rejects.toMatchObject({
			code: 'PERSISTENCE_REQUIRED',
		})
	})

	it.skipIf(!fontPath)(
		'loads provider-owned font files from env over file config and releases them on stop',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'pluxel-fonts-deployment-'))
			try {
				await writeFile(join(root, 'fonts.json'), JSON.stringify({ defaultFamily: 'monospace' }))
				const application = defineHostApplication(() => ({
					plugins: [FontsPlugin],
					fileBindings: [
						fileBinding(FontsPlugin, { config: { schema: FontsConfig, path: 'fonts.json' } }),
					],
					envBindings: [
						envBinding(FontsPlugin, {
							config: {
								schema: FontsConfig,
								mapping: { files: 'FONT_FILES', defaultFamily: 'FONT_FAMILY' },
							},
						}),
					],
				}))
				const resolved = await resolveHostApplication(application, {
					root,
					mode: 'test',
					bindings: {},
					env: { FONT_FILES: JSON.stringify([fontPath, fontPath]), FONT_FAMILY: 'serif' },
				})
				await using host = await createTestHost({
					services: [],
					configRecords: resolved.configRecords,
				})
				await host.start(FontsPlugin)
				let fonts = host.require(FontsPlugin)
				expect(fonts.ctx.workbench).toBeUndefined()
				expect(fonts.defaultFont).toMatchObject({ family: 'serif', source: 'config' })
				expect(fonts.portableFonts.fonts).toHaveLength(1)
				const resource = fonts.portableFonts.fonts[0]!
				expect(resource.family).toBeUndefined()
				const bytes = await fonts.readPortableFont(resource.id)
				expect(bytes.byteLength).toBe(resource.byteLength)
				await host.stop(FontsPlugin)
				await host.start(FontsPlugin)
				fonts = host.require(FontsPlugin)
				expect(fonts.portableFonts.fonts).toHaveLength(1)
				await expect(fonts.readPortableFont(resource.id)).resolves.toHaveLength(resource.byteLength)
			} finally {
				await rm(root, { recursive: true, force: true })
			}
		},
	)

	it.skipIf(!fontPath)(
		'fails startup for unreadable configured files and cleans preceding registrations',
		async () => {
			await using host = await createTestHost({ services: [] })
			const failure = await host.commitExpectFail((change) => {
				change.catalog.add([FontsPlugin])
				change.start(FontsPlugin, {
					initialConfig: { files: [fontPath!, join(tmpdir(), crypto.randomUUID(), 'missing.ttf')] },
				})
			})
			expect(failure.lifecycleReport.issues).toContainEqual(
				expect.objectContaining({
					plugin: pluginNodeAddressOf(FontsPlugin),
					kind: 'start-failed',
					message: expect.stringContaining('Cannot read configured font file'),
				}),
			)
			expect(host.isRunning(FontsPlugin)).toBe(false)
			const result = await host.config.patch(FontsPlugin, { files: [] })
			expect(result.ok).toBe(true)
			await host.start(FontsPlugin)
			expect(host.require(FontsPlugin).portableFonts.fonts).toEqual([])
		},
	)
})
