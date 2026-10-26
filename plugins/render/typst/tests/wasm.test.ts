import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pluginNodeAddressOf } from '@pluxel/core'
import { createTestHost } from '@pluxel/test'
import { afterEach, expect, it, vi } from 'vitest'
import { TypstPlugin } from '../src/wasm.ts'

const require = createRequire(import.meta.url)
const source =
	'#set page(width: 40pt, height: 40pt, margin: 0pt)\n#rect(width: 24pt, height: 24pt, fill: rgb("#e23456"))'

afterEach(() => vi.restoreAllMocks())

it('runs WASM through Pluxel, recovers source errors, and restarts without native services', async () => {
	const assets = new Map([
		[
			'https://example.test/compiler.wasm',
			require.resolve('@myriaddreamin/typst-ts-web-compiler/wasm'),
		],
		[
			'https://example.test/renderer.wasm',
			require.resolve('@myriaddreamin/typst-ts-renderer/wasm'),
		],
	])
	const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
		const path = assets.get(String(url))
		if (!path) throw new Error(`Unexpected request: ${url}`)
		return new Response(await readFile(path))
	})
	await using host = await createTestHost({
		configRecords: {
			initial: [
				{
					owner: pluginNodeAddressOf(TypstPlugin),
					config: {
						compilerWasmUrl: 'https://example.test/compiler.wasm',
						rendererWasmUrl: 'https://example.test/renderer.wasm',
						fontUrls: [],
					},
				},
			],
		},
	})
	const typst = await host.start(TypstPlugin)
	const rendering = typst.renderSvg(source)
	await expect(typst.renderSvg(source)).rejects.toMatchObject({ code: 'BUSY' })
	const svg = new TextDecoder().decode(await rendering)
	expect(svg).toContain('<svg')
	expect(svg).toContain('#e23456')
	expect(svg).not.toContain('<script')
	const included = '#set page(width: 40pt, height: 40pt, margin: 0pt)\n#include "section.typ"'
	const files = {
		'/section.typ':
			'#let data = json("/data.json")\n#link("pluxel:preview/shape")[#rect(width: 24pt, height: 24pt, fill: rgb(data.fill))]',
		'/data.json': '{"fill":"#e23456"}',
	}
	const withFiles = typst.renderSvg(included, { files })
	files['/data.json'] = '{"fill":"#123456"}'
	const linkedSvg = new TextDecoder().decode(await withFiles)
	expect(linkedSvg).toContain('#e23456')
	const link = linkedSvg.match(
		/xlink:href="pluxel:preview\/shape"><rect class="pseudo-link" width="([^"]+)" height="([^"]+)"/,
	)
	expect(link?.slice(1).map(Number)).toEqual([24, 24])
	await expect(typst.renderSvg(included)).rejects.toMatchObject({ code: 'COMPILE_FAILED' })
	for (const path of [
		'/main.typ',
		'relative.typ',
		'/a/../b.typ',
		'/a/./b.typ',
		'/a//b.typ',
		'/a\\b.typ',
		'/a\0b.typ',
		'/',
	])
		await expect(typst.renderSvg(source, { files: { [path]: '' } })).rejects.toMatchObject({
			code: 'INVALID_INPUT',
			path,
		})
	await expect(typst.renderSvg('#let =')).rejects.toMatchObject({
		code: 'COMPILE_FAILED',
		diagnostics: expect.arrayContaining([expect.objectContaining({ severity: 'error' })]),
	})
	await expect(typst.renderSvg('#import "@preview/nonexistent:0.1.0"')).rejects.toMatchObject({
		code: 'COMPILE_FAILED',
	})
	await expect(
		typst.renderSvg('#let =', { files: { '/leftover.typ': source } }),
	).rejects.toMatchObject({ code: 'COMPILE_FAILED' })
	await expect(typst.renderSvg('#include "leftover.typ"')).rejects.toMatchObject({
		code: 'COMPILE_FAILED',
	})
	expect(await typst.renderSvg(source)).toEqual(await rendering)
	await host.stop(TypstPlugin)
	await expect(typst.renderSvg(source)).rejects.toMatchObject({ code: 'CLOSED' })
	const restarted = await host.start(TypstPlugin)
	expect(new TextDecoder().decode(await restarted.renderSvg(source))).toContain('<svg')
	expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([...assets.keys(), ...assets.keys()])
}, 30_000)
