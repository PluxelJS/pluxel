import { CanvasPlugin } from '@pluxel/canvas'
import { FontsPlugin } from '@pluxel/fonts'
import { pluginNodeAddressOf, type RuntimeApplication } from '@pluxel/runtime'
import { EChartsPlugin } from '../../src/index.ts'
import { EChartsDynamicProbePlugin } from './echarts-dynamic-probe.ts'

const plugins = [FontsPlugin, CanvasPlugin, EChartsPlugin, EChartsDynamicProbePlugin] as const

export default {
	name: 'render-fixture',
	plugins,
	configure: () => ({
		configService: { mode: 'memory' },
		runtimeState: {
			mode: 'memory',
			snapshot: { autoStart: plugins.map((plugin) => pluginNodeAddressOf(plugin)) },
		},
		persistence: { mode: 'memory' },
		workbench: false,
		logging: false,
	}),
} satisfies RuntimeApplication
