// @vitest-environment jsdom

import type { PluginNodeAddress } from '@pluxel/core'
import type { PluginDependencyGraphNode, PluginStatusSnapshot } from '@pluxel/runtime/web'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PluginGraphRenderer } from '../src/app/plugin-graph/PluginGraphRenderer'
import type {
	PluginGraphVisualEdge,
	PluginGraphVisualModel,
	PluginGraphVisualNode,
} from '../src/app/plugin-graph/pluginGraphModel'

const mounted: Array<ReturnType<typeof createRoot>> = []
let boundingRectMock: ReturnType<typeof vi.spyOn>

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	boundingRectMock = vi
		.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
		.mockReturnValue(new DOMRect(0, 0, 800, 600))
	globalThis.ResizeObserver = class {
		constructor(private readonly callback: ResizeObserverCallback) {}
		observe(target: Element) {
			this.callback(
				[
					{
						target,
						contentRect: { width: 800, height: 600 },
					} as ResizeObserverEntry,
				],
				this as unknown as ResizeObserver,
			)
		}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver
})

afterAll(() => boundingRectMock.mockRestore())

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
})

describe('plugin graph renderer interaction', () => {
	it('opens relation-free nodes on demand without permanently shrinking the relation canvas', async () => {
		const visual = visualNode()
		const model = Object.freeze({
			view: 'effective' as const,
			mode: 'all' as const,
			nodes: Object.freeze([visual]),
			edges: Object.freeze([]),
			connectedNodes: Object.freeze([]),
			isolatedNodes: Object.freeze([visual]),
			components: Object.freeze([]),
			byId: new Map([[visual.id, visual]]),
			edgeById: new Map(),
			incomingById: new Map(),
			outgoingById: new Map(),
			searchTextById: new Map([[visual.id, `${visual.label} ${visual.reference}`]]),
			topologyKey: `effective|all|n:${visual.id}:1`,
		}) satisfies PluginGraphVisualModel
		const onSelect = vi.fn()
		const container = document.createElement('div')
		container.style.width = '800px'
		container.style.height = '600px'
		document.body.appendChild(container)
		const root = createRoot(container)
		mounted.push(root)

		await act(async () => {
			root.render(<PluginGraphRenderer model={model} selection={null} onSelect={onSelect} />)
			await new Promise<void>((resolve) => setTimeout(resolve, 0))
		})

		expect(container.querySelector('.plx-pluginGraphNode')).toBeNull()
		const toggle = container.querySelector<HTMLButtonElement>('.plx-pluginGraphUnconnectedToggle')
		expect(toggle?.textContent).toContain('独立节点 1')
		await act(async () => {
			toggle?.click()
			await Promise.resolve()
		})

		const node = container.querySelector<HTMLButtonElement>('.plx-pluginGraphNode')
		expect(node).not.toBeNull()
		expect(node?.tabIndex).toBe(0)
		expect(node?.getAttribute('aria-label')).toContain('Plugin 节点')
		expect(node?.getAttribute('aria-label')).toContain('运行中')
		expect(node?.getAttribute('aria-label')).toContain('当前有效图')
		expect(container.querySelector('[role="status"]')?.textContent).toContain(
			'当前筛选下没有依赖关系',
		)
		expect(container.querySelector('.plx-pluginGraphMiniMap')).toBeNull()

		await act(async () => {
			node?.focus()
			node?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
			await Promise.resolve()
		})

		expect(onSelect).toHaveBeenLastCalledWith(null)

		await act(async () => {
			node?.click()
			await Promise.resolve()
		})

		expect(onSelect).toHaveBeenLastCalledWith({ kind: 'node', node: visual })
		expect(container.querySelector('.plx-pluginGraphUnconnectedPanel')).toBeNull()
	})

	it('renders routed read-only edges with keyboard selection and no editor controls', async () => {
		const provider = visualNode('ProviderPlugin', 'Provider Plugin')
		const consumer = visualNode('ConsumerPlugin', 'Consumer Plugin')
		const unrelatedProvider = visualNode('OtherProvider', 'Other Provider')
		const unrelatedConsumer = visualNode('OtherConsumer', 'Other Consumer')
		const edge = visualEdge(provider, consumer, 'edge:provider-consumer')
		const unrelatedEdge = visualEdge(
			unrelatedProvider,
			unrelatedConsumer,
			'edge:other-provider-consumer',
		)
		const nodes = Object.freeze([provider, consumer, unrelatedProvider, unrelatedConsumer])
		const edges = Object.freeze([edge, unrelatedEdge])
		const model = Object.freeze({
			view: 'effective' as const,
			mode: 'all' as const,
			nodes,
			edges,
			connectedNodes: nodes,
			isolatedNodes: Object.freeze([]),
			components: Object.freeze([
				Object.freeze({
					id: 'component:fixture',
					nodes: Object.freeze([provider, consumer]),
					edges: Object.freeze([edge]),
				}),
				Object.freeze({
					id: 'component:unrelated',
					nodes: Object.freeze([unrelatedProvider, unrelatedConsumer]),
					edges: Object.freeze([unrelatedEdge]),
				}),
			]),
			byId: new Map(nodes.map((node) => [node.id, node] as const)),
			edgeById: new Map(edges.map((item) => [item.id, item] as const)),
			incomingById: new Map([
				[consumer.id, Object.freeze([edge])],
				[unrelatedConsumer.id, Object.freeze([unrelatedEdge])],
			]),
			outgoingById: new Map([
				[provider.id, Object.freeze([edge])],
				[unrelatedProvider.id, Object.freeze([unrelatedEdge])],
			]),
			searchTextById: new Map(
				nodes.map((node) => [node.id, `${node.label} ${node.reference}`] as const),
			),
			topologyKey: 'effective|all|two-components',
		}) satisfies PluginGraphVisualModel
		const onSelect = vi.fn()
		const container = document.createElement('div')
		container.style.width = '800px'
		container.style.height = '600px'
		document.body.appendChild(container)
		const root = createRoot(container)
		mounted.push(root)

		await act(async () => {
			root.render(<PluginGraphRenderer model={model} selection={null} onSelect={onSelect} />)
			await new Promise<void>((resolve) => setTimeout(resolve, 0))
		})

		const edgeElement = container.querySelector<SVGGElement>('.plx-pluginGraphEdge')
		expect(edgeElement?.getAttribute('role')).toBe('button')
		expect(edgeElement?.getAttribute('aria-label')).toContain('Provider Plugin 到 Consumer Plugin')
		const viewport = container.querySelector<HTMLElement>('[role="application"]')
		expect(viewport?.getAttribute('aria-label')).toContain('拖动平移、滚轮缩放')
		expect(container.querySelector('.react-flow')).toBeNull()

		await act(async () => {
			edgeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
			await Promise.resolve()
		})

		expect(onSelect).toHaveBeenCalledWith({ kind: 'edge', edge })
		await act(async () => {
			root.render(
				<PluginGraphRenderer
					model={model}
					selection={{ kind: 'edge', edge }}
					onSelect={onSelect}
				/>,
			)
			await Promise.resolve()
		})
		expect(
			container
				.querySelector(`[aria-label^="Other Provider 到 Other Consumer"]`)
				?.getAttribute('data-muted'),
		).toBe('true')
		expect(
			container
				.querySelector(`[aria-label^="Provider Plugin 到 Consumer Plugin"]`)
				?.getAttribute('data-muted'),
		).toBe('false')

		const stage = container.querySelector<HTMLElement>('.plx-pluginGraphStage')
		const fittedTransform = stage?.style.transform
		await act(async () => {
			viewport?.dispatchEvent(
				new WheelEvent('wheel', {
					bubbles: true,
					cancelable: true,
					clientX: 400,
					clientY: 300,
					deltaY: -120,
				}),
			)
			await Promise.resolve()
		})
		expect(stage?.style.transform).not.toBe(fittedTransform)

		await act(async () => {
			viewport?.focus()
			viewport?.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }))
			await Promise.resolve()
		})
		expect(stage?.style.transform).toBe(fittedTransform)

		await act(async () => {
			viewport?.dispatchEvent(pointerEvent('pointerdown', 120, 120))
			viewport?.dispatchEvent(pointerEvent('pointermove', 180, 150))
			viewport?.dispatchEvent(pointerEvent('pointerup', 180, 150))
			await Promise.resolve()
		})
		expect(stage?.style.transform).not.toBe(fittedTransform)
	})
})

function visualEdge(
	provider: Extract<PluginGraphVisualNode, { kind: 'plugin' }>,
	consumer: Extract<PluginGraphVisualNode, { kind: 'plugin' }>,
	id: string,
): PluginGraphVisualEdge {
	return Object.freeze({
		id,
		source: provider.id,
		target: consumer.id,
		mode: 'required' as const,
		effective: true,
		edge: Object.freeze({
			consumer: consumer.address,
			requirement: provider.address.definition,
			mode: 'required' as const,
			resolution: Object.freeze({
				state: 'resolved' as const,
				provider: provider.address,
				via: 'direct' as const,
			}),
			effective: true,
		}),
	})
}

function pointerEvent(type: string, clientX: number, clientY: number): MouseEvent {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX,
		clientY,
		button: 0,
	})
	Object.defineProperties(event, {
		pointerId: { value: 1 },
		pointerType: { value: 'mouse' },
	})
	return event
}

function visualNode(
	exportName = 'KeyboardPlugin',
	label = 'Keyboard Plugin',
): Extract<PluginGraphVisualNode, { kind: 'plugin' }> {
	const address = {
		definition: {
			entry: { kind: 'package-root', packageName: '@fixture/renderer-interaction' },
			exportName,
		},
		variant: 'default',
	} as const satisfies PluginNodeAddress
	const graphNode = Object.freeze({
		status: status(address, label),
		effective: true,
	}) satisfies PluginDependencyGraphNode
	return Object.freeze({
		id: `plugin:${exportName}`,
		kind: 'plugin',
		address,
		label,
		reference: graphNode.status.reference,
		effective: true,
		node: graphNode,
	})
}

function status(address: PluginNodeAddress, label: string): PluginStatusSnapshot {
	const exportName = address.definition.exportName
	return {
		address,
		reference: `package:@fixture/renderer-interaction::${exportName}`,
		route: `v1/package/${exportName}/@fixture/renderer-interaction`,
		displayName: exportName,
		label: { title: label, text: label },
		rootExportName: exportName,
		autoStart: true,
		sessionIntent: 'inherit',
		desiredState: 'running',
		activationReason: 'auto-start',
		lifecycleState: 'running',
		availability: 'available',
		issues: [],
		source: {
			kind: 'unknown',
			moduleId: null,
			packageName: null,
			version: null,
			tag: null,
		},
	}
}
