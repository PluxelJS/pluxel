import { CanvasPlugin } from '@pluxel/plugin-canvas'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { defineHostApplication } from '@pluxel/host'
import { elysia } from '@pluxel/services/elysia'
import { commands } from '@pluxel/services/commands'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { EChartsPlugin } from '../../../src/index.ts'
import { EChartsDynamicProbePlugin } from './probe.ts'

export default defineHostApplication(() => ({
	name: 'render-fixture',
	plugins: [
		{ plugin: FontsPlugin, autoStart: true },
		{ plugin: CanvasPlugin, autoStart: true },
		{ plugin: EChartsPlugin, autoStart: true },
		{ plugin: EChartsDynamicProbePlugin, autoStart: true },
	],
	services: [elysia(), commands(), nodeModules(), workers()],
	config: { document: false },
	policy: { document: false },
}))
