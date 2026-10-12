import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host'
import { FontsPlugin } from '@pluxel/fonts'
import { TypstPlugin } from '@pluxel/typst'
import { elysia } from '@pluxel/services/elysia'
import { nodeModules } from '@pluxel/services/node'
import { StudioPlugin } from '@report-template-studio/app/plugin'

/** One application contract for the source development host and packaged Electron host. */
export default defineHostApplication((startup) => {
	const { root, assetsRoot } = startup.bindings
	if (typeof root !== 'string' || typeof assetsRoot !== 'string')
		throw new TypeError('Studio requires data and asset roots')
	const owner = pluginNodeAddressOf(StudioPlugin)
	return {
		name: 'report-template-studio',
		plugins: [FontsPlugin, TypstPlugin, StudioPlugin],
		services: [
			elysia(),
			nodeModules(
				startup.mode === 'production'
					? {
							root: resolve(
								dirname(fileURLToPath(import.meta.resolve('@pluxel/typst/package.json'))),
								'dist/artifacts/node',
							),
						}
					: undefined,
			),
		],
		configRecords: {
			initial: [
				{ owner, config: { root, assetsRoot } },
				{ owner: pluginNodeAddressOf(FontsPlugin), config: { maxFontBytes: 32 * 1024 * 1024 } },
				{
					owner: pluginNodeAddressOf(TypstPlugin),
					config: { maxTemplateBytes: 128 * 1024 * 1024, maxFontBytes: 96 * 1024 * 1024 },
				},
			],
		},
		state: { initial: { autoStart: [owner] } },
	}
})
