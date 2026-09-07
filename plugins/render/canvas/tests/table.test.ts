import { type PluginConstructor } from '@pluxel/runtime'
import {
	BasePlugin,
	createRuntimeTestHost,
	Plugin,
	type RuntimeTestHost,
} from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { FontsPlugin } from '@pluxel/fonts'
import { CanvasPlugin } from '../src/index.ts'
import { drawTable, layoutTable } from '../src/table.ts'
import { createCanvasWorkerAdapter } from '../src/worker.ts'
import { createCanvasWorkerTextLayout } from '../src/worker-pretext.ts'

@Plugin()
class CanvasTableConsumer extends BasePlugin {
	constructor(readonly canvas: CanvasPlugin) {
		super()
	}
}

async function startCanvasFixture(
	host: RuntimeTestHost,
	plugins: readonly PluginConstructor[],
): Promise<void> {
	await host.commit((change) => {
		change.catalog.add(plugins)
		change.start(plugins)
	})
}

describe('Canvas table tools', () => {
	it('lays out bounded Pretext text and draws onto a caller-owned root surface', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await startCanvasFixture(host, [FontsPlugin, CanvasPlugin, CanvasTableConsumer])
		const canvas = host.require(CanvasTableConsumer).canvas
		const font = `14px ${canvas.defaultFont.cssFamily}`
		const table = layoutTable({
			x: 8,
			y: 6,
			width: 300,
			columns: [
				{ header: 'Service', weight: 2 },
				{ header: { text: 'Status', textAlign: 'center' }, width: 90 },
				{ header: 'P95', width: 70, textAlign: 'right' },
			],
			rows: [
				['A service name long enough to require an ellipsis in one table line', 'Healthy', 18.4],
				[{ text: 'Queue', background: '#fef3c7' }, 'Delayed', 81.2],
			],
			body: { font, lineHeight: 20, maxLines: 1, padding: 6 },
			header: { font: `700 14px ${canvas.defaultFont.cssFamily}`, background: '#e2e8f0' },
			alternateRowBackground: '#f8fafc',
			prepareText: (input) => canvas.prepareTextWithSegmentsSync(input),
		})

		expect(table.header?.kind).toBe('header')
		expect(table.columns.map((column) => column.width)).toEqual([140, 90, 70])
		expect(table.rows[0]?.cells[0]?.lines[0]?.text).toMatch(/…$/)
		expect(Object.isFrozen(table.rows)).toBe(true)

		const surface = canvas.createCanvasSync(340, Math.ceil(table.bounds.height + 20))
		const context = surface.getContext('2d')
		let customPaints = 0
		drawTable(context, table, {
			paintCell({ cell, context: target }) {
				if (cell.kind === 'body' && cell.rowIndex === 0 && cell.columnIndex === 1) {
					customPaints += 1
					target.fillStyle = '#ef4444'
					target.fillRect(cell.contentBounds.x + 2, cell.contentBounds.y + 2, 8, 8)
					target.globalAlpha = 0
					return 'skip-text'
				}
				return undefined
			},
		})

		expect(customPaints).toBe(1)
		expect(
			context.getImageData(
				table.rows[0]!.cells[1]!.contentBounds.x + 4,
				table.rows[0]!.cells[1]!.contentBounds.y + 4,
				1,
				1,
			).data[0],
		).toBe(239)
		expect(
			Array.from(
				context.getImageData(
					table.rows[1]!.cells[1]!.bounds.x + table.rows[1]!.cells[1]!.bounds.width - 4,
					table.rows[1]!.cells[1]!.bounds.y + table.rows[1]!.cells[1]!.bounds.height - 4,
					1,
					1,
				).data,
			),
		).toEqual([248, 250, 252, 255])
		const png = await surface.encode('png')
		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
	})

	it('uses the same table path with a detached worker text adapter', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await startCanvasFixture(host, [FontsPlugin, CanvasPlugin, CanvasTableConsumer])
		const snapshot = host.require(CanvasTableConsumer).canvas.workerSnapshot
		const workerCanvas = createCanvasWorkerAdapter(structuredClone(snapshot))
		const workerText = createCanvasWorkerTextLayout(structuredClone(snapshot))
		try {
			const table = layoutTable({
				width: 180,
				columns: [{ header: 'Name' }, { header: 'Value' }],
				rows: [['Worker table', '42']],
				body: { font: `14px ${snapshot.font.cssFamily}`, lineHeight: 20 },
				prepareText: (input) => workerText.prepareTextWithSegments(input),
			})
			const surface = workerCanvas.createCanvas(180, Math.ceil(table.bounds.height))
			drawTable(surface.getContext('2d'), table)
			const png = await surface.encode('png')

			expect(table.bounds.height).toBeGreaterThan(0)
			expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
		} finally {
			await workerCanvas.close()
		}
	})

	it('rejects ambiguous column sizing before text preparation', () => {
		expect(() =>
			layoutTable({
				width: 120,
				columns: [{ width: 100 }],
				rows: [['unused']],
				body: { font: '14px sans-serif', lineHeight: 20 },
				prepareText: () => {
					throw new Error('text preparation must not run')
				},
			}),
		).toThrow('add up to the table width exactly')
	})
})
