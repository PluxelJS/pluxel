import { FontsPlugin } from '@pluxel/plugin-fonts'
import { defineHostApplication } from '@pluxel/host'
import { elysia } from '@pluxel/services/elysia'
import { commands } from '@pluxel/services/commands'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { TypstDynamicProbePlugin } from './probe.ts'

export default defineHostApplication(() => ({
	name: 'typst-document-fixture',
	plugins: [
		{ plugin: FontsPlugin, autoStart: true },
		{ plugin: TypstPlugin, autoStart: true },
		{ plugin: TypstDynamicProbePlugin, autoStart: true },
	],
	services: [elysia(), commands(), nodeModules(), workers()],
	config: { document: false },
	policy: { document: false },
}))
