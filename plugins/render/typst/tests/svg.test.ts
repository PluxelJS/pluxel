import { BasePlugin, Plugin } from '@pluxel/core'
import { FontsPlugin } from '@pluxel/fonts'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { createTestHost } from '@pluxel/test'
import { describe, expect, it } from 'vitest'
import { TypstError, TypstPlugin } from '../src/index.ts'

@Plugin()
class SvgConsumer extends BasePlugin {
	constructor(readonly typst: TypstPlugin) {
		super()
	}
}

async function fixture(maxInputBytes?: number) {
	const host = await createTestHost({ services: [nodeModules(), workers({ maxThreads: 1 })] })
	try {
		await host.start(TypstPlugin, {
			catalog: [FontsPlugin],
			...(maxInputBytes === undefined ? {} : { initialConfig: { maxInputBytes } }),
		})
		await host.start(SvgConsumer, { catalog: [FontsPlugin, TypstPlugin] })
		return host
	} catch (error) {
		await host.dispose()
		throw error
	}
}

const source = '#set page(width: auto, height: auto, margin: 0pt)\n$x^2 + y^2 = z^2$'

describe('Typst stateless SVG through its injected provider', () => {
	it('renders independent documents through the shared Worker and keeps compile diagnostics', async () => {
		await using host = await fixture()
		const consumer = host.require(SvgConsumer)
		const svg = await consumer.typst.renderSvg(source)
		expect(Buffer.from(svg).toString('utf8', 0, 64)).toContain('<svg')
		expect(svg.byteLength).toBeGreaterThan(1_000)
		await expect(consumer.typst.renderSvg('#missing_symbol')).rejects.toMatchObject({
			name: 'TypstError',
			code: 'COMPILE_FAILED',
			diagnostics: expect.arrayContaining([expect.objectContaining({ severity: 'error' })]),
		})
		// A rejected source does not retain compiler state or poison the following document.
		const recovered = await consumer.typst.renderSvg(source)
		expect(recovered.byteLength).toBe(svg.byteLength)
	})

	it('applies per-call byte limits and cancellation without closing the provider', async () => {
		await using host = await fixture()
		const consumer = host.require(SvgConsumer)
		await expect(consumer.typst.renderSvg(source, { maxOutputBytes: 1 })).rejects.toMatchObject({
			code: 'LIMIT_EXCEEDED',
		})
		await expect(consumer.typst.renderSvg(source, { maxOutputBytes: 0 })).rejects.toMatchObject({
			code: 'INVALID_INPUT',
		})
		const reason = new Error('request cancelled')
		await expect(
			consumer.typst.renderSvg(source, { signal: AbortSignal.abort(reason) }),
		).rejects.toBe(reason)
		const recovered = await consumer.typst.renderSvg(source)
		expect(recovered.byteLength).toBeGreaterThan(1_000)
	})

	it('rejects an inactive provider with its stable lifecycle error', async () => {
		await using host = await fixture()
		const typst = host.require(TypstPlugin)
		await host.stop(SvgConsumer)
		await host.stop(TypstPlugin)
		await expect(typst.renderSvg(source)).rejects.toBeInstanceOf(TypstError)
		await expect(typst.renderSvg(source)).rejects.toMatchObject({ code: 'CLOSED' })
	})

	it('counts UTF-8 bytes before dispatch, including non-BMP characters', async () => {
		await using host = await fixture(3)
		await expect(host.require(SvgConsumer).typst.renderSvg('😀')).rejects.toMatchObject({
			code: 'LIMIT_EXCEEDED',
		})
	})
})
