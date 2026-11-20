import type { Workbench } from '@pluxel/workbench'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePluginNodeAddress, defineServiceRef } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import {
	defineHostApplication,
	envBinding,
	fileBinding,
	resolveHostApplication,
} from '@pluxel/host'
import { createResolvedHost } from '@pluxel/host/internal'
import { createTestHost } from '@pluxel/test'
import { describe, expect, it } from 'vitest'
import { FontsConfig, FontsPlugin } from '../src/index.ts'

const WorkbenchRef = defineServiceRef<Workbench>()
const fontPath = [
	'/usr/share/fonts/dejavu/DejaVuSans.ttf',
	'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
	'/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
	'/System/Library/Fonts/Supplemental/Arial.ttf',
	process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'arial.ttf') : '',
].find((path) => path && existsSync(path))

describe('Fonts deployment without Workbench', () => {
	it('runs its core capability and saves preferences with no services', async () => {
		await using host = await createTestHost({ services: [] })
		await host.start(FontsPlugin.nodeAddress(), { initialConfig: { defaultFamily: 'serif' } })
		const fonts = host.require(FontsPlugin.nodeAddress())
		expect(fonts.ctx.service(WorkbenchRef)).toBeUndefined()
		expect(fonts.ctx.fs).toBeTypeOf('function')
		expect(fonts.defaultFont).toMatchObject({ family: 'serif', source: 'config' })
		expect(fonts.portableFonts.fonts).toEqual([])
		await fonts.setPreferredFamily('monospace')
		expect(fonts.defaultFont).toMatchObject({
			family: 'serif',
			source: 'config',
			preferredFamily: 'monospace',
		})
	})

	it.skipIf(!fontPath)(
		'loads provider-owned font files from env over file config and releases them on stop',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'pluxel-fonts-deployment-'))
			try {
				await writeFile(join(root, 'fonts.json'), JSON.stringify({ defaultFamily: 'monospace' }))
				const application = defineHostApplication(() => ({
					plugins: [
						{
							plugin: FontsPlugin,
							autoStart: true,
							envBindings: [
								envBinding({
									config: {
										schema: FontsConfig,
										mapping: { files: 'FONT_FILES', defaultFamily: 'FONT_FAMILY' },
									},
								}),
							],
							fileBindings: [
								fileBinding({
									config: { schema: FontsConfig, path: 'fonts.json' },
								}),
							],
						},
					],
				}))
				const resolved = await resolveHostApplication(application, {
					root,
					mode: 'test',
					bindings: {},
					env: { FONT_FILES: JSON.stringify([fontPath, fontPath]), FONT_FAMILY: 'serif' },
				})
				await using host = await createResolvedHost(resolved)
				await host.start()
				const plugins = requirePluginService(host.ctx)
				const fonts = plugins.getInstance(FontsPlugin)!
				expect(fonts.ctx.service(WorkbenchRef)).toBeUndefined()
				expect(fonts.defaultFont).toMatchObject({ family: 'serif', source: 'config' })
				expect(fonts.portableFonts.fonts).toHaveLength(1)
				const resource = fonts.portableFonts.fonts[0]!
				expect(resource.family).toBeUndefined()
				const bytes = await fonts.readPortableFont(resource.id)
				expect(bytes.byteLength).toBe(resource.byteLength)
				await host.stopNode(FontsPlugin.nodeAddress())
				await host.startNode(FontsPlugin.nodeAddress())
				const restarted = plugins.getInstance(FontsPlugin)!
				expect(restarted).not.toBe(fonts)
				expect(restarted.portableFonts.fonts).toHaveLength(1)
				await expect(restarted.readPortableFont(resource.id)).resolves.toHaveLength(
					resource.byteLength,
				)
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
				change.start(FontsPlugin.nodeAddress(), {
					initialConfig: { files: [fontPath!, join(tmpdir(), crypto.randomUUID(), 'missing.ttf')] },
				})
			})
			expect(failure.lifecycleReport.issues).toContainEqual(
				expect.objectContaining({
					plugin: parsePluginNodeAddress(FontsPlugin.nodeAddress()),
					kind: 'start-failed',
					message: expect.stringContaining('Cannot read configured font file'),
				}),
			)
			expect(host.isRunning(FontsPlugin.nodeAddress())).toBe(false)
			const result = await host.config.patch(FontsPlugin.nodeAddress(), { set: { files: [] } })
			expect(result.ok).toBe(true)
			await host.start(FontsPlugin.nodeAddress())
			expect(host.require(FontsPlugin.nodeAddress()).portableFonts.fonts).toEqual([])
		},
	)
})
