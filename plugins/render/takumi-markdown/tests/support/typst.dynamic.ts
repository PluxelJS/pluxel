import { InMemory } from '@pluxel/services/fs'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host'
import { standardServices } from '@pluxel/services'
import { TakumiPlugin } from '@pluxel/plugin-takumi'
import { TakumiMarkdownPlugin } from '../../src/index.ts'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { TypstDynamicProbePlugin } from './typst-dynamic-probe.ts'

const plugins = [
	FontsPlugin,
	TakumiPlugin,
	TakumiMarkdownPlugin,
	TypstPlugin,
	TypstDynamicProbePlugin,
] as const

export default defineHostApplication(() => ({
	name: 'render-fixture',
	plugins,
	configRecords: { mode: 'memory' },
	state: { mode: 'memory', initial: { autoStart: plugins.map(pluginNodeAddressOf) } },
	services: standardServices({ fs: { backend: InMemory } }),
}))
