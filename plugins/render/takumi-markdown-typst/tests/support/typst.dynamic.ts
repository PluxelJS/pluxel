import { FontsPlugin } from '@pluxel/fonts'
import { pluginNodeAddressOf } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host'
import { standardServices } from '@pluxel/services'
import { TakumiPlugin } from '@pluxel/takumi'
import { TakumiMarkdownPlugin } from '@pluxel/takumi-markdown'
import { TypstMathPlugin } from '../../src/index.ts'
import { TypstDynamicProbePlugin } from './typst-dynamic-probe.ts'

const plugins = [
	FontsPlugin,
	TakumiPlugin,
	TakumiMarkdownPlugin,
	TypstMathPlugin,
	TypstDynamicProbePlugin,
] as const

export default defineHostApplication(() => ({
	name: 'render-fixture',
	plugins,
	configRecords: { mode: 'memory' },
	state: { mode: 'memory', initial: { autoStart: plugins.map(pluginNodeAddressOf) } },
	services: standardServices({ persistence: { mode: 'memory' } }),
}))
