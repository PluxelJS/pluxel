import { FontsPlugin } from '@pluxel/plugin-fonts'
import { defineHostApplication } from '@pluxel/host'
import { standardServices } from '@pluxel/services'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { TypstDynamicProbePlugin } from './typst-dynamic-probe.ts'

const plugins = [FontsPlugin, TypstPlugin, TypstDynamicProbePlugin] as const

export default defineHostApplication(() => ({
	name: 'typst-document-fixture',
	plugins,
	services: standardServices(),
	runtime: {
		configRecords: { mode: 'memory' },
		state: { mode: 'memory', autoStart: plugins.map((plugin) => plugin.nodeAddress()) },
	},
}))
