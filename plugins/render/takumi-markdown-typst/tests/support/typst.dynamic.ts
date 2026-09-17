import { FontsPlugin } from '@pluxel/fonts'
import { pluginNodeAddressOf } from '@pluxel/core'
import { type RuntimeApplication } from '@pluxel/runtime'
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

export default {
	name: 'render-fixture',
	plugins,
	configure: () => ({
		configService: { mode: 'memory' },
		runtimeState: { mode: 'memory', snapshot: { autoStart: plugins.map(pluginNodeAddressOf) } },
		persistence: { mode: 'memory' },
		workbench: false,
		logging: false,
	}),
} satisfies RuntimeApplication
