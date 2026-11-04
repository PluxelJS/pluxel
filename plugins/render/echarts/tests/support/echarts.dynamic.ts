import { CanvasPlugin } from '@pluxel/plugin-canvas'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { defineHostApplication } from '@pluxel/host'
import { standardServices } from '@pluxel/services'
import { EChartsPlugin } from '../../src/index.ts'
import { EChartsDynamicProbePlugin } from './echarts-dynamic-probe.ts'

const plugins = [FontsPlugin, CanvasPlugin, EChartsPlugin, EChartsDynamicProbePlugin] as const

export default defineHostApplication(() => ({
	name: 'render-fixture',
	plugins,
	services: standardServices(),
	policy: { autoStart: plugins.map((plugin) => plugin.nodeAddress()) },
	runtime: { documents: { config: false, state: false } },
}))
