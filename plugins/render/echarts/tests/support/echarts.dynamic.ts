import { CanvasPlugin } from '@pluxel/canvas'
import { FontsPlugin } from '@pluxel/fonts'
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
import { EChartsPlugin } from '../../src/index.ts'
import { EChartsDynamicProbePlugin } from './echarts-dynamic-probe.ts'

const plugins = [FontsPlugin, CanvasPlugin, EChartsPlugin, EChartsDynamicProbePlugin] as const

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	configPath: 'tests/support/echarts.loader.hmr.jsonc',
	profile: 'test',
	plugins,
	configService: { mode: 'memory' },
	runtimeState: {
		mode: 'memory',
		snapshot: { autoStart: plugins.map((plugin) => pluginNodeAddressOf(plugin)) },
	},
	persistence: { mode: 'memory' },
	workbench: false,
	logging: false,
	printUrls: false,
})
