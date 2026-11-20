import { cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createPluginSemanticsPlugin } from '@pluxel/rolldown/plugins'
import { build, type Plugin } from 'vite-plus'
import { expect, it } from 'vitest'
import { createWorkspace } from '../support/workspace'
import type * as fixture from './fixtures/runtime/entry'

it('runs the lowered dependency graph and drains it without Node globals', async () => {
	await using workspace = await createWorkspace('browser', ['host'])
	const { root } = workspace
	await writeFile(
		join(root, 'package.json'),
		'{"name":"browser-host-fixture","private":true,"type":"module"}',
	)
	await cp(new URL('./fixtures/runtime/', import.meta.url), root, { recursive: true })
	const output = await build({
		configFile: false,
		root,
		logLevel: 'silent',
		oxc: { decorator: { legacy: true } },
		resolve: {
			conditions: ['@pluxel/source', 'source', 'browser', 'module', 'production'],
		},
		plugins: [createPluginSemanticsPlugin({ root }).plugin as unknown as Plugin],
		build: {
			write: false,
			minify: false,
			lib: { entry: join(root, 'entry.ts'), formats: ['iife'], name: 'browserHost' },
		},
	})
	const outputs = Array.isArray(output) ? output : [output]
	const chunks = outputs.flatMap((result) => {
		if (!('output' in result)) throw new Error('Expected an immediate browser build')
		return result.output.filter((chunk) => chunk.type === 'chunk')
	})
	expect(chunks).toHaveLength(1)
	const code = chunks[0]!.code
	expect(code).not.toContain('__vite-browser-external')
	const modules = chunks.flatMap((chunk) => Object.keys(chunk.modules))
	for (const name of ['logging', 'fs']) {
		expect(modules.some((id) => id.endsWith(`/core/src/${name}/config.ts`))).toBe(true)
	}
	expect(
		modules.filter((id) =>
			/(?:^|\0)node:|\/@logtape\/(?:file|pretty)\/|\/@logtape\+(?:file|pretty)@|\/core\/src\/logging\/(?:file|pretty)\./.test(
				id,
			),
		),
	).toEqual([])
	expect(chunks[0]!.imports).toEqual([])
	// The selected backend's lazy import is inlined into the same IIFE.
	expect(chunks[0]!.dynamicImports.filter((id) => id !== chunks[0]!.fileName)).toEqual([])
	const run = runInNewContext(`${code}\nbrowserHost.run`, {
		console,
		TextEncoder,
		TextDecoder,
		URL,
		structuredClone,
		AbortController,
		AbortSignal,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		queueMicrotask,
		performance,
		crypto,
	}) as typeof fixture.run
	const result = await run()
	expect(result.started.core).toMatchObject({
		status: 'committed',
		summary: { lifecycleReport: { ok: true } },
	})
	expect(result.running.summary).toMatchObject({ total: 2, running: 2 })
	expect(result.stopped.summary.running).toBe(0)
	expect(result.trace).toEqual([
		'provider started',
		'hello from dependency',
		'consumer closed',
		'provider closed',
	])
	expect(result.logging).toEqual({ initial: 'installed', final: 'disposed' })
	expect(result.sinkLifecycle).toEqual(['drained', 'disposed'])
	expect(result.rootId).toEqual(expect.any(String))
	const lifecycleMessages = [
		'host prepared',
		'provider started',
		'consumer started',
		'consumer closed',
		'provider closed',
		'host closing',
	]
	const lifecycleRecords = result.records.filter((record) =>
		lifecycleMessages.includes(record.message),
	)
	expect(lifecycleRecords.map((record) => record.message)).toEqual(lifecycleMessages)
	for (const record of lifecycleRecords) {
		expect(record.category.slice(0, 3)).toEqual([
			'pluxel',
			record.message.startsWith('host ') ? 'runtime' : 'plugins',
			result.rootId,
		])
	}
	expect(lifecycleRecords.find((record) => record.message === 'provider started')?.storage).toBe(
		'browser storage',
	)
}, 30_000)
