import { CanvasPlugin } from '@pluxel/canvas'
import { FontsPlugin } from '@pluxel/fonts'
import { pluginNodeAddressOf } from '@pluxel/core'
import type { HostApplication } from '@pluxel/host'
import { standardServices } from '@pluxel/services'
import { EChartsPlugin } from '../../src/index.ts'
import { EChartsDynamicProbePlugin } from './echarts-dynamic-probe.ts'

const plugins = [FontsPlugin, CanvasPlugin, EChartsPlugin, EChartsDynamicProbePlugin] as const

export default {
	name: 'render-fixture',
	plugins,
	configure: () => ({
		configRecords: { mode: 'memory' },
		state: { mode: 'memory', initial: { autoStart: plugins.map(pluginNodeAddressOf) } },
		services: standardServices({ persistence: { mode: 'memory' } }),
	}),
} satisfies HostApplication
