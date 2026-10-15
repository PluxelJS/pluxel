import { BasePlugin, Plugin } from '@pluxel/core'
import { createTestHost } from '@pluxel/test'
import { createContext, createElement, useContext, useState } from 'react'
import { renderSvg, type RenderOptions } from 'takumi-js'
import { describe, expect, it } from 'vitest'
import { TakumiPlugin } from '../src/index.ts'

@Plugin()
class Consumer extends BasePlugin {
	constructor(readonly takumi: TakumiPlugin) {
		super()
	}
}

async function fixture() {
	const host = await createTestHost({ services: [] })
	await host.commit((change) => {
		change.catalog.add([TakumiPlugin, Consumer])
		change.start(Consumer)
	})
	return host
}

describe('Takumi native API', () => {
	it('renders real React hooks and context using native CSS and return values without services', async () => {
		await using host = await fixture()
		const { takumi } = host.require(Consumer)
		const Title = createContext('fallback')
		function Card() {
			const [count] = useState(42)
			return createElement('div', { className: 'card' }, `${useContext(Title)} ${count}`)
		}
		const input = createElement(Title.Provider, { value: 'Report' }, createElement(Card))
		const options: RenderOptions = {
			width: 160,
			height: 80,
			css: '.card { width: 100%; height: 100%; background: #123456; color: white; }',
			emoji: 'from-font',
		}
		const png = await takumi.render(input, options)
		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
		const svg = await takumi.renderSvg(input, options)
		expect(svg).toBe(await renderSvg(input, options))
		expect(svg).toContain('<svg')
	})

	it('preserves native format options for HTML, node trees and animation', async () => {
		await using host = await fixture()
		const { takumi } = host.require(Consumer)
		const jpeg = await takumi.render(
			'<div style="background:red;width:100%;height:100%">Report</div>',
			{
				width: 80,
				height: 40,
				format: 'jpeg',
				quality: 85,
			},
		)
		expect([...jpeg.subarray(0, 3)]).toEqual([255, 216, 255])
		const webp = await takumi.render(
			{ type: 'container', style: { backgroundColor: 'blue' } },
			{
				width: 80,
				height: 40,
				format: 'webp',
				lossless: true,
			},
		)
		expect(Buffer.from(webp).toString('ascii', 8, 12)).toBe('WEBP')
		const animated = await takumi.renderAnimation({
			width: 16,
			height: 16,
			fps: 2,
			format: 'webp',
			scenes: [
				{ node: '<div style="background:red;width:100%;height:100%"></div>', durationMs: 500 },
				{ node: '<div style="background:blue;width:100%;height:100%"></div>', durationMs: 500 },
			],
		})
		expect(Buffer.from(animated).toString('ascii', 8, 12)).toBe('WEBP')
	})

	it('preserves upstream cancellation reasons and component exceptions', async () => {
		await using host = await fixture()
		const { takumi } = host.require(Consumer)
		const reason = new Error('caller stopped')
		await expect(takumi.render('<div/>', { signal: AbortSignal.abort(reason) })).rejects.toBe(
			reason,
		)
		function Broken(): never {
			throw reason
		}
		await expect(takumi.render(createElement(Broken))).rejects.toBe(reason)
	})
})
