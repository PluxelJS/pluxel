import { FontsPlugin } from '@pluxel/plugin-fonts'
import { defineHostApplication } from '@pluxel/host'
import { elysia } from '@pluxel/services/elysia'
import { commands } from '@pluxel/services/commands'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { TakumiPlugin } from '@pluxel/plugin-takumi'
import { TakumiMarkdownPlugin } from '../../../src/index.ts'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { MarkdownMathProbePlugin } from './probe.ts'

export default defineHostApplication(() => ({
	name: 'render-fixture',
	plugins: [
		{ plugin: FontsPlugin, autoStart: true },
		{ plugin: TakumiPlugin, autoStart: true },
		{ plugin: TakumiMarkdownPlugin, autoStart: true },
		{ plugin: TypstPlugin, autoStart: true },
		{ plugin: MarkdownMathProbePlugin, autoStart: true },
	],
	services: [elysia(), commands(), nodeModules(), workers()],
	config: { document: false },
	policy: { document: false },
}))
