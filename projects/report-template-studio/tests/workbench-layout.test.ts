// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { createWorkbench } from '@worksplit/react'
import { Actions, DockLocation, TabNode } from 'flexlayout-react'
import { assistantTab, createStudioLayout, documentTarget } from '../src/renderer/workbench-layout'

function testWorkbench() {
	const root = createRootRoute()
	const form = createRoute({
		getParentRoute: () => root,
		path: '/form',
		validateSearch: (search: Record<string, unknown>) => ({ entry: String(search.entry ?? '') }),
	})
	const preview = createRoute({
		getParentRoute: () => root,
		path: '/preview',
		validateSearch: (search: Record<string, unknown>) => ({ entry: String(search.entry ?? '') }),
	})
	const routeTree = root.addChildren([form, preview])
	return createWorkbench({
		home: { href: '/', mode: 'empty' },
		initial: { layout: createStudioLayout() },
		createRouter: (history) => createRouter({ history, routeTree }),
		tools: { 'studio.assistant': { render: () => null } },
	})
}

describe('Studio native docking lifecycle', () => {
	it('recycles closed split groups and opens form/preview again after closing all documents', async () => {
		const workbench = testWorkbench()
		try {
			await workbench.start({ href: '/' })
			const open = async (kind: 'form' | 'preview', entry: string) => {
				const target = documentTarget(
					kind,
					workbench.getContainers(),
					workbench.getDocuments(),
					workbench.getContext().activeContainerId,
				)
				const source = workbench.getActiveDocument()
				const canReveal =
					kind === 'preview' &&
					target &&
					(target.location !== DockLocation.CENTER || target.target !== source?.containerId)
				const result = await workbench.open(
					{ to: `/${kind}`, search: { entry } },
					{
						destination: target,
						source: source?.handle,
						presentation: canReveal ? 'reveal' : 'activate',
					},
				)
				if (result.status === 'failed') throw result.error
				if (result.status !== 'applied') throw new Error(JSON.stringify(result))
				return result.value.document
			}
			for (let cycle = 0; cycle < 3; cycle++) {
				const entry = `报表/季度分析-${cycle}/季度分析-${cycle}.ts`
				const form = await open('form', entry)
				const preview = await open('preview', entry)
				expect(form.containerId).not.toBe(preview.containerId)
				expect(
					workbench.getContainers().filter((container) => container.kind === 'tabset'),
				).toHaveLength(2)
				expect(workbench.getActiveDocument()?.id).toBe(form.id)
				for (let split = 0; split < 4; split++) {
					const duplicate = await workbench.duplicate(form.id, {
						destination: { target: form.containerId!, location: DockLocation.RIGHT },
					})
					if (duplicate.status !== 'applied') throw new Error(JSON.stringify(duplicate))
					expect(
						workbench.getContainers().filter((container) => container.kind === 'tabset'),
					).toHaveLength(3)
					const closed = await workbench.dispatch(
						Actions.deleteTabset(duplicate.value.document.containerId!),
					)
					expect(closed.status).toBe('applied')
					expect(workbench.getDocument(duplicate.value.document.id)).toBeNull()
					expect(
						workbench.getContainers().filter((container) => container.kind === 'tabset'),
					).toHaveLength(2)
				}
				// A user may deliberately merge editor and preview tabs. New documents
				// should follow that placement without creating another empty split.
				await workbench.dispatch(
					Actions.moveNode(preview.id, form.containerId!, DockLocation.CENTER, -1, true),
				)
				await open('form', `报表/新报表-${cycle}/新报表-${cycle}.ts`)
				await open('preview', `报表/新报表-${cycle}/新报表-${cycle}.ts`)
				expect(
					workbench.getContainers().filter((container) => container.kind === 'tabset'),
				).toHaveLength(1)
				for (const document of workbench.getDocuments()) {
					const closed = await workbench.close(document.id)
					expect(closed.status).toBe('applied')
				}
				expect(workbench.getDocuments()).toHaveLength(0)
				expect(
					workbench.getContainers().filter((container) => container.kind === 'tabset'),
				).toHaveLength(1)
			}
		} finally {
			await workbench.dispose()
		}
	})

	it('moves the same assistant tool between bottom/right/central and reopens it after close', async () => {
		const workbench = testWorkbench()
		try {
			await workbench.start({ href: '/' })
			for (const location of ['right', 'central', 'bottom']) {
				const target =
					location === 'central'
						? workbench.getContainers().find((container) => container.kind === 'tabset')?.id
						: `border_${location}`
				if (!target) throw new Error('Native root editor group is missing')
				const moved = await workbench.dispatch(
					Actions.moveNode('assistant', target, DockLocation.CENTER, -1, true),
				)
				expect(moved.status).toBe('applied')
				expect((workbench.model.getNodeById('assistant') as TabNode).isSelected()).toBe(true)
			}
			const closed = await workbench.close('assistant')
			expect(closed.status).toBe('applied')
			expect(workbench.getContent('assistant')).toBeNull()
			const reopened = await workbench.dispatch(
				Actions.addTab({ ...assistantTab }, 'border_bottom', DockLocation.CENTER, -1, true),
			)
			expect(reopened.status).toBe('applied')
			expect((workbench.model.getNodeById('assistant') as TabNode).isSelected()).toBe(true)
			expect(
				workbench.getContainers().filter((container) => container.kind === 'tabset'),
			).toHaveLength(1)
		} finally {
			await workbench.dispose()
		}
	})
})
