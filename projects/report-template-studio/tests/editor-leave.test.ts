import type { ContentController, LeaveRequest } from '@worksplit/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/api'
import { editorLifecycle } from '../src/renderer/editor-lifecycle'
import { WorkspaceController } from '../src/renderer/workspace'

vi.mock('../src/renderer/api', () => ({
	onDesktopConnectionChange: vi.fn(),
	api: { writeFile: vi.fn() },
}))
let workspace: WorkspaceController
const path = 'notes.typ'
function request(controller: ContentController) {
	const releases: (() => void)[] = []
	const value: LeaveRequest = {
		reason: 'close',
		location: null,
		content: { id: 'notes', runEffect: () => () => {} },
		state: controller.leave!.getState(),
		signal: new AbortController().signal,
		defer: (release) => releases.push(release),
	}
	return { value, release: () => releases.toReversed().forEach((release) => release()) }
}

beforeEach(() => {
	workspace = new WorkspaceController({ id: 'project', name: 'Project', root: '/project' })
	workspace.files.set(path, {
		path,
		content: 'Saved',
		saved: 'Saved',
		version: 'v1',
		dirty: false,
		saving: false,
		token: 0,
		external: 0,
	})
	vi.spyOn(workspace, 'refresh').mockResolvedValue(true)
})
afterEach(() => {
	workspace.dispose()
	vi.restoreAllMocks()
	vi.resetAllMocks()
})

describe('Studio shared edit decisions', () => {
	it('denies a clean draft whose write has not been confirmed', async () => {
		workspace.files.get(path)!.saving = true
		const controller = editorLifecycle(workspace, path, 'file')
		const current = request(controller)
		expect(controller.leave!.getState().hasUnsavedChanges).toBe(false)
		expect(await controller.leave!.decide(current.value)).toEqual({ decision: 'deny' })
		expect(workspace.isDirty()).toBe(true)
	})

	it('keeps edits made while the reviewed draft is being saved', async () => {
		workspace.edit(path, 'Reviewed')
		let complete!: (value: { path: string; content: string; version: string }) => void
		vi.mocked(api.writeFile).mockImplementation(
			() =>
				new Promise((resolve) => {
					complete = resolve
				}),
		)
		const controller = editorLifecycle(workspace, path, 'file')
		const current = request(controller)
		const deciding = controller.leave!.decide(current.value)
		await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
		workspace.edit(path, 'Newer user input')
		complete({ path, content: 'Reviewed', version: 'v2' })
		expect(await deciding).toEqual({ decision: 'deny' })
		expect(workspace.files.get(path)).toMatchObject({
			content: 'Newer user input',
			saved: 'Reviewed',
			dirty: true,
		})
		expect(workspace.isEditingPaused(path)).toBe(false)
	})

	it('retains independent pause leases until every approved native request finishes', async () => {
		const controller = editorLifecycle(workspace, path, 'file')
		const first = request(controller),
			second = request(controller)
		expect(await controller.leave!.decide(first.value)).toMatchObject({ decision: 'allow' })
		expect(await controller.leave!.decide(second.value)).toMatchObject({ decision: 'allow' })
		workspace.edit(path, 'Blocked during loading')
		expect(workspace.files.get(path)?.content).toBe('Saved')
		first.release()
		expect(workspace.isEditingPaused(path)).toBe(true)
		second.release()
		expect(workspace.isEditingPaused(path)).toBe(false)
		workspace.edit(path, 'After loading')
		expect(workspace.files.get(path)?.content).toBe('After loading')
	})
})
