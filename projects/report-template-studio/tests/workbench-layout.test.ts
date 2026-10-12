import { describe, expect, it } from 'vitest'
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { createWorkbench } from '@worksplit/react'
import { Actions, DockLocation } from 'flexlayout-react'
import {
	assistantTab,
	createStudioLayout,
	documentTarget,
	editorGroups,
	findTool,
} from '../src/renderer/workbench-layout'

function testWorkbench() {
	const root = createRootRoute()
	const form = createRoute({
		getParentRoute: () => root,
		path: '/form',
		validateSearch: (search: Record<string, unknown>) => ({ entry: String(search.entry ?? '') }),
		staticData: { worksplit: { identitySearch: ['entry'] } },
	})
	const preview = createRoute({
		getParentRoute: () => root,
		path: '/preview',
		validateSearch: (search: Record<string, unknown>) => ({ entry: String(search.entry ?? '') }),
		staticData: { worksplit: { identitySearch: ['entry'] } },
	})
	const routeTree = root.addChildren([form, preview])
	return createWorkbench({
		home: '/',
		homeMode: 'empty',
		layout: createStudioLayout(),
		createRouter: (history) => createRouter({ history, routeTree }),
		tools: [{ id: 'assistant', render: () => null }],
	})
}

describe('Studio native docking lifecycle', () => {
	it('recycles closed split groups and opens form/preview again after closing all documents', async () => {
		const workbench = testWorkbench()
		try {
			await workbench.start('/')
			const open = async (kind: 'form' | 'preview', entry: string) => {
				const target = documentTarget(
					kind,
					workbench.getLayout(),
					workbench.getDocuments(),
					workbench.getEditingContext().activeGroupId,
				)
				const active = workbench.getActiveDocument()
				const result = await workbench.open(
					{ to: `/${kind}`, search: { entry } },
					{
						...target,
						preserveFocus:
							kind === 'preview' &&
							Boolean(
								active && (target.location !== undefined || target.target !== active.containerId),
							),
					},
				)
				if (result.status !== 'committed') throw new Error(JSON.stringify(result))
				return result.document
			}
			for (let cycle = 0; cycle < 3; cycle++) {
				const entry = `报表/季度分析-${cycle}/季度分析-${cycle}.ts`
				const form = await open('form', entry)
				const preview = await open('preview', entry)
				expect(form.containerId).not.toBe(preview.containerId)
				expect(editorGroups(workbench.getLayout().layout)).toHaveLength(2)
				expect(workbench.getActiveDocument()?.id).toBe(form.id)
				for (let split = 0; split < 4; split++) {
					const duplicate = await workbench.duplicate(form.id, {
						target: form.containerId,
						location: DockLocation.RIGHT,
					})
					if (duplicate.status !== 'committed') throw new Error(JSON.stringify(duplicate))
					expect(editorGroups(workbench.getLayout().layout)).toHaveLength(3)
					const closed = await workbench.dispatch(
						Actions.deleteTabset(duplicate.document.containerId),
					)
					expect(closed.status).toBe('closed')
					expect(workbench.getDocument(duplicate.document.id)).toBeNull()
					expect(editorGroups(workbench.getLayout().layout)).toHaveLength(2)
				}
				// A user may deliberately merge editor and preview tabs. New documents
				// should follow that placement without creating another empty split.
				await workbench.dispatch(
					Actions.moveNode(preview.id, form.containerId, DockLocation.CENTER, -1, true),
				)
				await open('form', `报表/新报表-${cycle}/新报表-${cycle}.ts`)
				await open('preview', `报表/新报表-${cycle}/新报表-${cycle}.ts`)
				expect(editorGroups(workbench.getLayout().layout)).toHaveLength(1)
				for (const document of workbench.getDocuments()) {
					const closed = await workbench.close(document.id)
					expect(closed.status).toBe('closed')
				}
				expect(workbench.getDocuments()).toHaveLength(0)
				expect(editorGroups(workbench.getLayout().layout)).toHaveLength(1)
			}
		} finally {
			await workbench.dispose()
		}
	})

	it('moves the same assistant tool between bottom/right/central and reopens it after close', async () => {
		const workbench = testWorkbench()
		try {
			await workbench.start('/')
			for (const location of ['right', 'central', 'bottom']) {
				const target =
					location === 'central'
						? editorGroups(workbench.getLayout().layout)[0]?.id
						: `border_${location}`
				if (!target) throw new Error('Native root editor group is missing')
				const moved = await workbench.dispatch(
					Actions.moveNode('assistant', target, DockLocation.CENTER, -1, true),
				)
				expect(moved.status).toBe('applied')
				expect(findTool(workbench.getLayout(), 'assistant')?.selected).toBe(true)
			}
			const closed = await workbench.close('assistant')
			expect(closed.status).toBe('closed')
			expect(findTool(workbench.getLayout(), 'assistant')).toBeUndefined()
			const reopened = await workbench.dispatch(
				Actions.addTab({ ...assistantTab }, 'border_bottom', DockLocation.CENTER, -1, true),
			)
			expect(reopened.status).toBe('applied')
			expect(findTool(workbench.getLayout(), 'assistant')?.selected).toBe(true)
			expect(editorGroups(workbench.getLayout().layout)).toHaveLength(1)
		} finally {
			await workbench.dispose()
		}
	})
})
