// @vitest-environment jsdom

import { act, useEffect, useMemo } from 'react'
import type { Root } from 'react-dom/client'
import { useRouter, type AnyRouter } from '@tanstack/react-router'
import { Actions } from 'flexlayout-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSession } from '../src/app/workbench/session'
import { useOptionalWorkbenchDocument } from '../src/app/workbench/document'
import {
	openDocument,
	prepareNativeWorkbenchDom,
	renderWorkspace,
} from './helpers/native-workbench'

type EditingModel = {
	dirty: boolean
	revision: number
	save?: () => Promise<void>
	dispose: ReturnType<typeof vi.fn<() => void>>
	router: AnyRouter
}
const fixtures = vi.hoisted(() => ({
	models: new Map<string, EditingModel>(),
	decisions: [] as { onConfirm?: () => void; onCancel?: () => void; title?: unknown }[],
}))
vi.mock('../src/app/log_viewer/LogPreview', () => ({ LogPreview: () => null }))
vi.mock('@mantine/modals', async (importOriginal) => ({
	...(await importOriginal<typeof import('@mantine/modals')>()),
	openConfirmModal: (options: (typeof fixtures.decisions)[number]) => {
		fixtures.decisions.push(options)
	},
}))
vi.mock('../src/app/log_viewer/LogsPage', () => ({ LogsPage: Editor }))
vi.mock('../src/app/security/SecurityScreen', () => ({ SecurityScreen: Editor }))
vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({ WorkspaceNavigation: () => null }))

function Editor() {
	const document = useOptionalWorkbenchDocument()!
	const router = useRouter()
	const model = useMemo<EditingModel>(
		() => ({ dirty: false, revision: 0, router, dispose: vi.fn() }),
		[document.id, router],
	)
	useEffect(() => {
		fixtures.models.set(document.id, model)
		const editor = {
			isDirty: () => model.dirty,
			getCloseRevision: () => model.revision,
			get save() {
				return model.save
			},
		}
		document.state.editor = editor
		const unregister = document.state.registerResource(model.dispose)
		return () => {
			unregister()
			if (document.state.editor === editor) document.state.editor = undefined
		}
	}, [document.state, document.id, model])
	return (
		<input
			aria-label={`draft ${document.id}`}
			defaultValue="draft"
			onInput={() => {
				model.dirty = true
				model.revision++
			}}
		/>
	)
}

const mounted: Root[] = []
const sessions: WorkspaceSession[] = []
beforeEach(prepareNativeWorkbenchDom)
afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
		for (const session of sessions.splice(0)) await session.dispose()
	})
	document.body.replaceChildren()
	window.localStorage.clear()
	window.history.replaceState(null, '', '/')
	fixtures.models.clear()
	fixtures.decisions.length = 0
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
async function fixture() {
	const session = new WorkspaceSession({ basepath: '/' })
	sessions.push(session)
	const { container, root } = await renderWorkspace(session)
	mounted.push(root)
	const first = await openDocument(session, '/logs')
	const second = await openDocument(session, '/security')
	return { session, container, first, second }
}
async function decide(index: number, confirm: boolean) {
	await act(async () => {
		await vi.waitFor(() => expect(fixtures.decisions[index]).toBeDefined())
		if (confirm) fixtures.decisions[index]!.onConfirm?.()
		else fixtures.decisions[index]!.onCancel?.()
	})
}

describe('native document close and save decisions', () => {
	it('keeps the whole deletion batch when a later dirty document refuses, even after an earlier save', async () => {
		const { session, first, second, container } = await fixture()
		const firstModel = fixtures.models.get(first)!
		firstModel.dirty = true
		const save = vi.fn(async () => {
			firstModel.dirty = false
			firstModel.revision++
		})
		firstModel.save = save
		fixtures.models.get(second)!.dirty = true
		const firstInput = container.querySelector<HTMLInputElement>(`[aria-label="draft ${first}"]`)!
		firstInput.value = 'business draft'
		let closing!: Promise<boolean>
		await act(async () => {
			closing = session.closeDocuments()
		})
		expect(session.workbench.getDocuments()).toHaveLength(2)
		await decide(0, true)
		await decide(1, false)
		await act(async () => expect(await closing).toBe(false))
		expect(save).toHaveBeenCalledOnce()
		expect(firstModel.dirty).toBe(false)
		expect(session.workbench.getDocuments().map((document) => document.id)).toEqual([first, second])
		expect(container.querySelector(`[aria-label="draft ${first}"]`)).toBe(firstInput)
		expect(firstInput.value).toBe('business draft')
		expect(firstModel.dispose).not.toHaveBeenCalled()
		expect(fixtures.models.get(second)!.dispose).not.toHaveBeenCalled()
	})

	it('rechecks the first real editing revision after waiting for the second decision and deletes zero labels on change', async () => {
		const { session, first, second } = await fixture()
		const firstModel = fixtures.models.get(first)!
		firstModel.dirty = true
		fixtures.models.get(second)!.dirty = true
		let closing!: Promise<boolean>
		await act(async () => {
			closing = session.closeDocuments()
		})
		await decide(0, true)
		await vi.waitFor(() => expect(fixtures.decisions[1]).toBeDefined())
		firstModel.revision++
		await decide(1, true)
		await act(async () => expect(await closing).toBe(false))
		expect(session.workbench.getDocuments()).toHaveLength(2)
		expect(firstModel.dispose).not.toHaveBeenCalled()
	})

	it('rejects remote dirty batch close without inventing an editing revision', async () => {
		const { session, first } = await fixture()
		session.documents.get(first)!.remoteDirty = true
		const report = vi.spyOn(session, 'report').mockImplementation(() => {})
		await act(async () => expect(await session.closeDocuments()).toBe(false))
		expect(report).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('revision-required') }),
		)
		expect(fixtures.decisions).toHaveLength(0)
		expect(session.workbench.getDocuments()).toHaveLength(2)
	})

	it('rejects the entire batch when an approved editor owner is replaced even with an equal business revision', async () => {
		const { session, first, second } = await fixture()
		const firstModel = fixtures.models.get(first)!
		firstModel.dirty = true
		fixtures.models.get(second)!.dirty = true
		let closing!: Promise<boolean>
		await act(async () => {
			closing = session.closeDocuments()
		})
		await decide(0, true)
		await vi.waitFor(() => expect(fixtures.decisions[1]).toBeDefined())
		const state = session.documents.get(first)!
		state.editor = { isDirty: () => true, getCloseRevision: () => firstModel.revision }
		await decide(1, true)
		await act(async () => expect(await closing).toBe(false))
		expect(session.workbench.getDocuments().map((document) => document.id)).toEqual([first, second])
		expect(firstModel.dispose).not.toHaveBeenCalled()
	})

	it('rejects the entire batch when remote dirty revokes an approved editing revision at a later wait point', async () => {
		const { session, first, second } = await fixture()
		const firstModel = fixtures.models.get(first)!
		firstModel.dirty = true
		fixtures.models.get(second)!.dirty = true
		let closing!: Promise<boolean>
		await act(async () => {
			closing = session.closeDocuments()
		})
		await decide(0, true)
		await vi.waitFor(() => expect(fixtures.decisions[1]).toBeDefined())
		session.documents.get(first)!.remoteDirty = true
		await decide(1, true)
		await act(async () => expect(await closing).toBe(false))
		expect(session.workbench.getDocuments().map((document) => document.id)).toEqual([first, second])
		expect(firstModel.dispose).not.toHaveBeenCalled()
	})

	it('keeps the input and reports a failed save instead of closing the document', async () => {
		const { session, first, container } = await fixture()
		const model = fixtures.models.get(first)!
		model.dirty = true
		model.save = vi.fn(async () => {
			throw new Error('save transport failed')
		})
		const input = container.querySelector<HTMLInputElement>(`[aria-label="draft ${first}"]`)!
		input.value = 'unsaved input'
		let closing!: ReturnType<typeof session.workbench.close>
		await act(async () => {
			closing = session.workbench.close(first)
		})
		await decide(0, true)
		await act(async () =>
			expect(await closing).toMatchObject({
				status: 'failed',
				error: expect.objectContaining({ message: 'save transport failed' }),
			}),
		)
		expect(model.dirty).toBe(true)
		expect(session.workbench.getDocument(first)).not.toBeNull()
		expect(container.querySelector(`[aria-label="draft ${first}"]`)).toBe(input)
		expect(input.value).toBe('unsaved input')
	})

	it('allows search/hash edits in a dirty document and rejects a pathname departure with no ghost browser history', async () => {
		const { session, first } = await fixture()
		window.history.replaceState(null, '', '/logs')
		session.workbench.connectBrowser()
		await act(async () => session.workbench.activate(first))
		const model = fixtures.models.get(first)!
		model.dirty = true
		await act(async () => {
			await model.router.navigate({ to: '/logs', search: { category: 'error' }, hash: 'tail' })
		})
		expect(fixtures.decisions).toHaveLength(0)
		expect(session.workbench.getDocument(first)?.href).toBe('/logs?category=error#tail')
		const accepted = window.location.href
		await act(async () => {
			void model.router.navigate({ to: '/security' })
		})
		await decide(0, false)
		await vi.waitFor(() => expect(fixtures.decisions).toHaveLength(1))
		expect(model.router.state.location.pathname).toBe('/logs')
		expect(window.location.href).toBe(accepted)
		expect(session.workbench.getDocument(first)?.href).toBe('/logs?category=error#tail')
	})

	it('refuses reset before deleting any pinned or protected document, preserving the native model and saved snapshot', async () => {
		const { session, first } = await fixture()
		await act(async () => {
			await session.workbench.dispatch(Actions.setTabPinned(first, true))
		})
		const original = session.workbench.snapshot()
		const write = vi.spyOn(session.storage, 'write')
		const dispose = vi.spyOn(session.workbench, 'dispose')
		const report = vi.spyOn(session, 'report').mockImplementation(() => {})
		let resetting!: Promise<boolean>
		await act(async () => {
			resetting = session.resetLayout()
		})
		await decide(0, true)
		await act(async () => expect(await resetting).toBe(false))
		expect(session.workbench.snapshot()).toEqual(original)
		expect(write).not.toHaveBeenCalled()
		expect(dispose).not.toHaveBeenCalled()
		expect(report).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('解除固定或关闭保护') }),
		)
	})

	it('disposes content once after an accepted close and preserves the other instance', async () => {
		const { session, first, second } = await fixture()
		const firstModel = fixtures.models.get(first)!
		await act(async () => {
			const result = await session.workbench.close(first)
			expect(result.status).toBe('closed')
		})
		expect(firstModel.dispose).toHaveBeenCalledOnce()
		expect(session.workbench.getDocument(second)).not.toBeNull()
		expect(fixtures.models.get(second)!.dispose).not.toHaveBeenCalled()
	})
})

describe('workspace departure decisions', () => {
	it('refuses departure when an earlier saved document changes while a later decision is pending and restores its accepted URL', async () => {
		const { session, first, second, container } = await fixture()
		const firstModel = fixtures.models.get(first)!
		firstModel.dirty = true
		firstModel.save = vi.fn(async () => {
			firstModel.dirty = false
			firstModel.revision++
		})
		fixtures.models.get(second)!.dirty = true
		const input = container.querySelector<HTMLInputElement>(`[aria-label="draft ${first}"]`)!
		window.history.replaceState(null, '', '/foreign')
		vi.spyOn(console, 'error').mockImplementation(() => {})
		let leaving!: Promise<unknown>
		await act(async () => {
			leaving = session.leave('/security#left').catch((cause: unknown) => cause)
		})
		await decide(0, true)
		await vi.waitFor(() => expect(fixtures.decisions[1]).toBeDefined())
		firstModel.dirty = true
		firstModel.revision++
		input.value = 'new edit during departure'
		await decide(1, true)
		await act(async () => {
			expect(await leaving).toMatchObject({ message: expect.stringContaining('退出期间文档') })
		})
		expect(window.location.pathname + window.location.search + window.location.hash).toBe(
			'/security',
		)
		expect(session.workbench.getDocuments().map((document) => document.id)).toEqual([first, second])
		expect(container.querySelector(`[aria-label="draft ${first}"]`)).toBe(input)
		expect(input.value).toBe('new edit during departure')
		expect(firstModel.dirty).toBe(true)
		expect(firstModel.save).toHaveBeenCalledOnce()
		expect(firstModel.dispose).not.toHaveBeenCalled()
	})

	it('refuses departure when a previously approved editor is replaced by another owner with an equal revision', async () => {
		const { session, first, second, container } = await fixture()
		const firstModel = fixtures.models.get(first)!
		firstModel.dirty = true
		fixtures.models.get(second)!.dirty = true
		const input = container.querySelector<HTMLInputElement>(`[aria-label="draft ${first}"]`)!
		window.history.replaceState(null, '', '/foreign')
		vi.spyOn(console, 'error').mockImplementation(() => {})
		let leaving!: Promise<unknown>
		await act(async () => {
			leaving = session.leave('/security#left').catch((cause: unknown) => cause)
		})
		await decide(0, true)
		await vi.waitFor(() => expect(fixtures.decisions[1]).toBeDefined())
		session.documents.get(first)!.editor = {
			isDirty: () => true,
			getCloseRevision: () => firstModel.revision,
		}
		await decide(1, true)
		await act(async () => {
			expect(await leaving).toMatchObject({ message: expect.stringContaining('退出期间文档') })
		})
		expect(window.location.pathname + window.location.hash).toBe('/security')
		expect(session.workbench.getDocuments()).toHaveLength(2)
		expect(container.querySelector(`[aria-label="draft ${first}"]`)).toBe(input)
		expect(firstModel.dispose).not.toHaveBeenCalled()
	})

	it('accepts unchanged save and discard decisions while retaining the final native beforeunload protection for dirty content', async () => {
		const { session, first, second } = await fixture()
		const firstModel = fixtures.models.get(first)!
		firstModel.dirty = true
		firstModel.save = vi.fn(async () => {
			firstModel.dirty = false
			firstModel.revision++
		})
		fixtures.models.get(second)!.dirty = true
		window.history.replaceState(null, '', '/security')
		await act(async () => {
			await session.start('/security', false)
		})
		let leaving!: Promise<void>
		await act(async () => {
			leaving = session.leave('/security#left')
		})
		await decide(0, true)
		await decide(1, true)
		await act(async () => {
			await leaving
		})
		await vi.waitFor(() => expect(window.location.hash).toBe('#left'))
		expect(firstModel.save).toHaveBeenCalledOnce()
		expect(firstModel.dirty).toBe(false)
		expect(fixtures.models.get(second)!.dirty).toBe(true)
		expect(session.workbench.getDocuments()).toHaveLength(2)
		const beforeUnload = new Event('beforeunload', { cancelable: true })
		window.dispatchEvent(beforeUnload)
		expect(beforeUnload.defaultPrevented).toBe(true)
	})
})
