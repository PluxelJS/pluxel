import { FontsPlugin } from '@pluxel/fonts'
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
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

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	configPath: 'tests/support/typst.loader.hmr.jsonc',
	profile: 'test',
	plugins,
	configService: { mode: 'memory' },
	runtimeState: { mode: 'memory', snapshot: { autoStart: plugins.map(pluginNodeAddressOf) } },
	persistence: { mode: 'memory' },
	workbench: false,
	logging: false,
	printUrls: false,
})
