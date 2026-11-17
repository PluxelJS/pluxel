import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineHostApplication, type HostApplication } from '@pluxel/host'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { nodeModules } from '@pluxel/services/node'
import * as nativeFs from 'node:fs'
import { Passthrough } from '@pluxel/core/fs'
import { StudioPlugin } from '@report-template-studio/app/plugin'
import { DOCUMENT_POLICY } from './documents.js'

/** One application contract for the source development host and packaged Electron host. */
export default defineHostApplication(async (startup): Promise<HostApplication> => {
	const { root, assetsRoot } = startup.bindings
	if (typeof root !== 'string' || typeof assetsRoot !== 'string')
		throw new TypeError('Studio requires data and asset roots')
	const owner = StudioPlugin.nodeAddress()
	const prefix = resolve(root, 'fs')
	await nativeFs.promises.mkdir(prefix, { recursive: true })
	return {
		name: 'report-template-studio',
		plugins: [FontsPlugin, TypstPlugin, StudioPlugin],
		services: [
			nodeModules(
				startup.mode === 'production'
					? {
							root: resolve(
								dirname(fileURLToPath(import.meta.resolve('@pluxel/plugin-typst/package.json'))),
								'dist/artifacts/node',
							),
						}
					: undefined,
			),
		],
		config: {
			records: [
				{ owner, config: { root, assetsRoot } },
				{ owner: FontsPlugin.nodeAddress(), config: { maxFontBytes: 32 * 1024 * 1024 } },
				{
					owner: TypstPlugin.nodeAddress(),
					config: {
						maxTemplateBytes: 128 * 1024 * 1024,
						maxFontBytes: 96 * 1024 * 1024,
						maxSessions: DOCUMENT_POLICY.maxSessions,
						maxQueuedUpdates: DOCUMENT_POLICY.maxQueuedUpdates,
					},
				},
			],
		},
		policy: { autoStart: [owner] },
		runtime: {
			zenfs: {
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			},
		},
	}
})
