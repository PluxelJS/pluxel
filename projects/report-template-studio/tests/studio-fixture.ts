import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createTestHost } from '@pluxel/test'
import { nodeModules } from '@pluxel/services/node'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { StudioPlugin } from '../src/backend/plugin.js'
export async function studioFixture(name: string) {
	const root = await mkdtemp(join(tmpdir(), 'studio-source-')),
		host = await createTestHost({ services: [nodeModules()] })
	try {
		await host.commit((change) => {
			change.catalog.add([FontsPlugin, TypstPlugin, StudioPlugin])
			change.start(FontsPlugin, { initialConfig: { maxFontBytes: 32 * 1024 * 1024 } })
			change.start(TypstPlugin, {
				initialConfig: { maxTemplateBytes: 128 * 1024 * 1024, maxFontBytes: 96 * 1024 * 1024 },
			})
			change.start(StudioPlugin, {
				initialConfig: { root, assetsRoot: resolve('financial-document-assets') },
			})
		})
		const studio = host.require(StudioPlugin),
			project = await studio.createProject({ name })
		return {
			root,
			studio,
			project,
			async [Symbol.asyncDispose]() {
				await host[Symbol.asyncDispose]()
				await rm(root, { recursive: true, force: true })
			},
		}
	} catch (cause) {
		await host[Symbol.asyncDispose]()
		await rm(root, { recursive: true, force: true })
		throw cause
	}
}
