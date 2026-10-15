import { randomUUID } from 'node:crypto'
import { isMainThread, threadId } from 'node:worker_threads'
import { Renderer } from '@takumi-rs/core'
import { createContext, createElement, useContext, useMemo, useState } from 'react'
import { render, renderSvg } from '../../src/worker.ts'
import { getWorkerRenderer } from '../../src/renderer-cache.ts'
import type { Font } from 'takumi-js'

export type ProbeInput = { fonts?: Font[]; gate?: Int32Array }
export type ProbeOutput = {
	label: string
	moduleId: string
	rendererId: number
	threadId: number
	isMainThread: boolean
	png: Uint8Array
	svg: string
}
const moduleId = randomUUID()
const IDS = Symbol.for('pluxel.takumi.test.renderer-ids')
type Ids = { next: number; values: WeakMap<object, number> }

export async function probe(label: string, input: ProbeInput): Promise<ProbeOutput> {
	const scope = globalThis as typeof globalThis & { [IDS]?: Ids }
	const ids = (scope[IDS] ??= { next: 0, values: new WeakMap() })
	const renderer = getWorkerRenderer(Renderer, input.fonts).renderer
	let rendererId = ids.values.get(renderer)
	if (rendererId === undefined) ids.values.set(renderer, (rendererId = ++ids.next))
	const Title = createContext('fallback')
	function Card() {
		const [count] = useState(42)
		const title = useMemo(() => 'Report', [])
		const context = useContext(Title)
		if (input.gate) {
			Atomics.store(input.gate, 0, 1)
			Atomics.wait(input.gate, 1, 0, 5_000)
			Atomics.store(input.gate, 2, 1)
		}
		return createElement(
			'div',
			{ style: { background: '#123456', color: 'white', width: '100%', height: '100%' } },
			`${context} ${title} ${count}`,
		)
	}
	const options = { width: 160, height: 80, fonts: input.fonts, emoji: 'from-font' as const }
	const content = createElement(Title.Provider, { value: 'Worker' }, createElement(Card))
	const png = await render(content, options)
	// Do not block the same test gate a second time when serializing the SVG.
	const svg = await renderSvg(
		'<div style="width:100%;height:100%;color:white">Worker Report 42</div>',
		options,
	)
	return { label, moduleId, rendererId, threadId, isMainThread, png, svg }
}
