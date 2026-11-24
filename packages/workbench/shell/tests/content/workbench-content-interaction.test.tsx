// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type {
	WorkbenchContentDataOutcome,
	WorkbenchContentPlan,
	WorkbenchContentPresentation,
	WorkbenchOpenedContentHandle,
} from '@pluxel/workbench/client'
import type { FieldNode } from 'valibot-form'
import { workbench } from '@pluxel/workbench'
import {
	WorkbenchContentTarget,
	attachWorkbenchContentTarget,
	prepareWorkbenchContentContract,
} from '@pluxel/workbench/internal'
import type { ContextLogger } from '@pluxel/core'
import { parseWorkbenchContentPlan } from '@pluxel/core/internal'
import * as v from 'valibot'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { prepareReactDom } from '../fixtures/react-dom'
import { WorkbenchContentController } from '../../src/app/workbench/WorkbenchContentController'
import { WorkbenchContentRenderer } from '../../src/app/workbench/WorkbenchContentRenderer'
import { type WorkbenchContentInteraction } from '../../src/app/workbench/WorkbenchContentSlots'

const statusField = field({
	kind: 'picklist',
	name: 'status',
	control: 'select',
	entries: [{ value: 'ready', label: 'Ready to serve' }],
})
const profileField = field({
	kind: 'object',
	name: 'profile',
	fields: [
		field({ kind: 'string', name: 'host', control: 'text', label: 'Host', depth: 1 }),
		field({ kind: 'boolean', name: 'enabled', control: 'switch', label: 'Enabled', depth: 1 }),
	],
})
const nameField = field({ kind: 'string', name: 'name', control: 'text', label: 'Name' })
const titleField = field({ kind: 'string', name: 'title', control: 'text', label: 'Title' })

const plan = {
	version: 1,
	kind: 'workbench-content',
	document: {
		version: 1,
		blocks: [
			{ type: 'slot', key: 'status' },
			{ type: 'slot', key: 'refresh' },
			{ type: 'slot', key: 'restart' },
			{ type: 'slot', key: 'save' },
			{ type: 'slot', key: 'edit' },
		],
	},
	slots: [
		{ kind: 'data', key: 'status', display: 'block' },
		{ kind: 'action', key: 'refresh', display: 'block', label: 'Refresh', input: 'none' },
		{
			kind: 'action',
			key: 'restart',
			display: 'block',
			label: 'Restart',
			input: 'none',
			confirm: 'Restart the service?',
		},
		{ kind: 'action', key: 'save', display: 'block', label: 'Save', input: 'embedded' },
		{ kind: 'action', key: 'edit', display: 'block', label: 'Edit', input: 'dialog' },
	],
} satisfies WorkbenchContentPlan

const presentation = {
	slots: [
		{ kind: 'data', key: 'status', display: 'block', field: statusField },
		{ kind: 'action', key: 'refresh', label: 'Refresh', input: 'none' },
		{
			kind: 'action',
			key: 'restart',
			label: 'Restart',
			input: 'none',
			confirm: 'Restart the service?',
		},
		{ kind: 'action', key: 'save', label: 'Save', input: 'embedded', fields: [nameField] },
		{ kind: 'action', key: 'edit', label: 'Edit', input: 'dialog', fields: [titleField] },
	],
} satisfies WorkbenchContentPresentation

const initialData = {
	sequence: 1,
	ok: true,
	data: { status: 'ready' },
} satisfies WorkbenchContentDataOutcome

const mounted = new Set<Root>()

beforeAll(prepareReactDom)

afterEach(async () => {
	await act(async () => {
		for (const root of mounted) root.unmount()
	})
	mounted.clear()
	document.body.replaceChildren()
	vi.clearAllMocks()
})

describe('interactive Workbench Content', () => {
	it('recovers an initial error and later retries stale data without reopening Content', async () => {
		let observer!: (outcome: WorkbenchContentDataOutcome) => void | Promise<void>
		const subscribe = vi.fn(async (next: typeof observer): Promise<WorkbenchContentDataOutcome> => {
			observer = next
			return { sequence: 1, ok: false, code: 'load_failed' }
		})
		const load = vi
			.fn()
			.mockResolvedValueOnce({ ...initialData, sequence: 2 })
			.mockResolvedValueOnce({ sequence: 4, ok: true, data: { status: 'recovered' } })
		const { container } = await renderInteractive({ subscribe, load })

		expect(container.textContent).toContain('数据加载失败')
		expect(container.textContent).not.toContain('Ready to serve')
		await click(button(container, '重试'))
		expect(container.textContent).toContain('Ready to serve')

		await act(async () => observer({ sequence: 3, ok: false, code: 'load_failed' }))
		expect(container.textContent).toContain('显示的是上次数据')
		expect(container.textContent).toContain('Ready to serve')
		await click(button(container, '重试'))

		expect(container.textContent).toContain('recovered')
		expect(container.textContent).not.toContain('显示的是上次数据')
		expect(load).toHaveBeenCalledTimes(2)
		expect(subscribe).toHaveBeenCalledOnce()
	})

	it('runs no-input actions, requests confirmation, and applies action-pushed data', async () => {
		const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
		const notify = vi.fn()
		const run = vi.fn(async (key: string) => ({
			action: { ok: true as const, message: `${key} complete` },
			data:
				key === 'refresh'
					? {
							sequence: 2,
							ok: true as const,
							data: { ...initialData.data, status: 'refreshed' },
						}
					: null,
		}))
		const fixture = await renderInteractive({ run }, { confirm, notify })
		await tick()

		await click(button(fixture.container, 'Refresh'))
		expect(run).toHaveBeenCalledWith('refresh')
		expect(fixture.container.textContent).toContain('refresh complete')
		expect(fixture.container.textContent).toContain('refreshed')
		expect(notify).toHaveBeenCalledWith({
			title: 'Refresh',
			message: 'refresh complete',
			tone: 'success',
		})
		expect(
			fixture.container
				.querySelector('.plx-workbenchContent__actionFeedback')
				?.getAttribute('role'),
		).toBe('status')

		await click(button(fixture.container, 'Restart'))
		expect(run).not.toHaveBeenCalledWith('restart')
		await click(button(fixture.container, 'Restart'))
		expect(confirm).toHaveBeenLastCalledWith({
			title: 'Restart',
			message: 'Restart the service?',
			confirmLabel: 'Restart',
			cancelLabel: '取消',
			tone: 'danger',
		})
		expect(run).toHaveBeenCalledWith('restart')
	})

	it('prevents confirmation re-entry and recovers when confirmation rejects', async () => {
		const confirmation = Promise.withResolvers<boolean>()
		const confirm = vi
			.fn()
			.mockImplementationOnce(() => confirmation.promise)
			.mockResolvedValueOnce(true)
		const run = vi.fn(async () => ({ action: { ok: true as const }, data: null }))
		const fixture = await renderInteractive({ run }, { confirm })
		await tick()
		const restart = button(fixture.container, 'Restart')

		await act(async () => {
			restart.click()
			restart.click()
		})

		expect(confirm).toHaveBeenCalledOnce()
		expect(run).not.toHaveBeenCalled()

		await act(async () => confirmation.reject(new Error('dialog unavailable')))
		expect(fixture.container.textContent).toContain('操作失败，请重试。')
		expect(
			fixture.container
				.querySelector('.plx-workbenchContent__actionFeedback')
				?.getAttribute('role'),
		).toBe('alert')

		await click(restart)
		expect(confirm).toHaveBeenCalledTimes(2)
		expect(run).toHaveBeenCalledOnce()
		expect(run).toHaveBeenCalledWith('restart')
	})

	it('keeps action execution active across StrictMode effect replay', async () => {
		const run = vi.fn(async () => ({ action: { ok: true as const }, data: null }))
		const fixture = await renderInteractive({ run }, {}, true)
		await tick()

		await click(button(fixture.container, 'Refresh'))

		expect(run).toHaveBeenCalledOnce()
		expect(run).toHaveBeenCalledWith('refresh')
	})

	it.each(['success', 'validation'] as const)(
		'preserves action drafts edited during a pending response (%s)',
		async (outcome) => {
			let resolve!: (result: unknown) => void
			const run = vi.fn(
				() =>
					new Promise<any>((done) => {
						resolve = done
					}),
			)
			const fixture = await renderInteractive({ run })
			await tick()
			const input = fixture.container.querySelector<HTMLInputElement>('input[name="name"]')!
			await change(input, 'submitted')
			await click(button(fixture.container, 'Save'))
			expect(run).toHaveBeenCalledOnce()
			await change(input, 'newer draft')
			await act(async () =>
				resolve({
					action:
						outcome === 'success'
							? { ok: true }
							: {
									ok: false,
									code: 'validation_failed',
									issues: [{ path: ['name'], message: 'Stale rejection' }],
								},
					data: null,
				}),
			)
			expect(input.value).toBe('newer draft')
			expect(fixture.container.textContent).not.toContain('Stale rejection')
		},
	)

	it('maps server validation into AutoForm, preserves a failed draft, and clears it on success', async () => {
		const run = vi
			.fn()
			.mockResolvedValueOnce({
				action: {
					ok: false,
					code: 'validation_failed',
					issues: [{ path: ['name'], message: 'Name is required' }],
				},
				data: null,
			})
			.mockResolvedValueOnce({ action: { ok: true }, data: null })
		const fixture = await renderInteractive({ run })
		await tick()
		const input = fixture.container.querySelector<HTMLInputElement>('input[name="name"]')!
		const actionForm = fixture.container.querySelector<HTMLFormElement>('form')!
		expect(actionForm.getAttribute('aria-label')).toBe('Save表单')
		expect(input.getAttribute('aria-label')).toBe('Name')

		await change(input, 'draft name')
		await click(button(fixture.container, 'Save'))

		expect(run).toHaveBeenNthCalledWith(1, 'save', { name: 'draft name' })
		expect(input.value).toBe('draft name')
		expect(fixture.container.textContent).toContain('Name is required')

		await change(input, 'corrected name')
		expect(fixture.container.textContent).not.toContain('Name is required')

		await submit(actionForm)
		expect(run).toHaveBeenNthCalledWith(2, 'save', { name: 'corrected name' })
		expect(input.value).toBe('')
		expect(fixture.container.textContent).not.toContain('Name is required')
	})

	it('submits an empty-start action through its published fields and server schema', async () => {
		const defaultMode = vi.fn(() => 'fixed' as const)
		const save = workbench.action({
			label: 'Save',
			form: 'embedded',
			input: v.strictObject({
				name: v.pipe(v.string(), v.minLength(1)),
				mode: v.optional(v.literal('fixed'), defaultMode),
			}),
		})
		const actionPlan = parseWorkbenchContentPlan({
			version: 1,
			kind: 'workbench-content',
			document: { version: 1, blocks: [{ type: 'slot', key: 'save' }] },
			slots: [{ kind: 'action', key: 'save', display: 'block', label: 'Save', input: 'embedded' }],
		})
		const contract = prepareWorkbenchContentContract({ save }, actionPlan)
		const handler = vi.fn()
		using server = new WorkbenchContentTarget(contract, {
			error: vi.fn(),
		} as unknown as ContextLogger)
		attachWorkbenchContentTarget(server, { actions: new Map([['save', handler]]) })
		const run = vi.fn((key: string, input?: unknown) => server.runDto(key, input))
		const fromPublication: WorkbenchContentPresentation = {
			slots: presentation.slots.map((slot) =>
				slot.key === 'save' ? contract.presentation.slots[0]! : slot,
			),
		}
		const fixture = await renderInteractive({ run }, {}, false, fromPublication)
		const input = fixture.container.querySelector<HTMLInputElement>('input[name="name"]')!
		expect(input.value).toBe('')
		expect(defaultMode).not.toHaveBeenCalled()
		await change(input, 'Ada')
		await click(button(fixture.container, 'Save'))
		expect(run).toHaveBeenCalledExactlyOnceWith('save', { name: 'Ada' })
		expect(defaultMode).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledExactlyOnceWith({ name: 'Ada', mode: 'fixed' })
	})

	it('shows nested server errors beside their inputs and keeps unmounted issues visible', async () => {
		const run = vi
			.fn()
			.mockResolvedValueOnce({
				action: {
					ok: false,
					code: 'validation_failed',
					issues: [
						{ path: ['profile', 'host'], message: 'Invalid nested host' },
						{ path: ['removed'], message: 'Unavailable field rejected' },
					],
				},
				data: null,
			})
			.mockResolvedValueOnce({ action: { ok: true }, data: null })
		const nestedPresentation: WorkbenchContentPresentation = {
			...presentation,
			slots: presentation.slots.map((slot) =>
				slot.kind === 'action' && slot.input === 'embedded' && slot.key === 'save'
					? { ...slot, fields: [profileField] }
					: slot,
			),
		}
		const fixture = await renderInteractive({ run }, {}, false, nestedPresentation)
		await tick()
		const input = fixture.container.querySelector<HTMLInputElement>('input[name="profile.host"]')!
		await change(input, 'invalid')
		await click(button(fixture.container, 'Save'))
		expect(run).toHaveBeenNthCalledWith(1, 'save', { profile: { host: 'invalid' } })
		expect(input.getAttribute('aria-invalid')).toBe('true')
		const errorId = input.getAttribute('aria-describedby')!
		expect(document.getElementById(errorId)?.textContent).toContain('Invalid nested host')
		expect(fixture.container.textContent?.match(/Invalid nested host/g)).toHaveLength(1)
		expect(fixture.container.textContent).toContain('$.removed · Unavailable field rejected')
		await change(input, 'valid.example')
		expect(fixture.container.textContent).not.toContain('Invalid nested host')
		expect(fixture.container.textContent).not.toContain('Unavailable field rejected')
		await submit(fixture.container.querySelector<HTMLFormElement>('form')!)
		expect(run).toHaveBeenNthCalledWith(2, 'save', { profile: { host: 'valid.example' } })
	})

	it('discards a dialog draft when the dialog is cancelled', async () => {
		const fixture = await renderInteractive()
		await tick()

		await click(button(fixture.container, 'Edit'))
		const input = document.body.querySelector<HTMLInputElement>('input[name="title"]')!
		await change(input, 'temporary title')
		expect(input.value).toBe('temporary title')
		await click(button(document.body, '取消'))

		await click(button(fixture.container, 'Edit'))
		expect(document.body.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe('')
	})
})

async function renderInteractive(
	overrides: Partial<Pick<WorkbenchOpenedContentHandle, 'subscribe' | 'load' | 'run'>> = {},
	host: Partial<Pick<WorkbenchContentInteraction, 'confirm' | 'notify'>> = {},
	strict = false,
	formPresentation: WorkbenchContentPresentation = presentation,
) {
	const handle = interactiveHandle(overrides)
	const controller = new WorkbenchContentController(handle)
	controller.start()
	const interaction: WorkbenchContentInteraction = {
		presentation: formPresentation,
		controller,
		confirm: host.confirm ?? vi.fn(async () => true),
		notify: host.notify ?? vi.fn(),
	}
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	mounted.add(root)
	await act(async () => {
		root.render(
			<MantineProvider>
				{strict ? (
					<StrictMode>
						<WorkbenchContentRenderer interaction={interaction} plan={plan} />
					</StrictMode>
				) : (
					<WorkbenchContentRenderer interaction={interaction} plan={plan} />
				)}
			</MantineProvider>,
		)
	})
	return { container, controller, handle, root }
}

function interactiveHandle(
	overrides: Partial<
		Pick<WorkbenchOpenedContentHandle, 'presentation' | 'subscribe' | 'load' | 'run'>
	>,
): WorkbenchOpenedContentHandle {
	return {
		mode: 'interactive',
		presentation,
		subscribe: vi.fn(async () => initialData),
		load: vi.fn(async () => ({ ok: false, code: 'busy' })),
		run: vi.fn(async () => ({ action: { ok: true }, data: null })),
		...overrides,
	} as unknown as WorkbenchOpenedContentHandle
}

function field(
	input:
		| { kind: 'string'; control: 'text'; name?: string; label?: string; depth?: number }
		| { kind: 'boolean'; control: 'switch'; name?: string; label?: string; depth?: number }
		| {
				kind: 'picklist'
				control: 'select'
				name?: string
				label?: string
				depth?: number
				entries: readonly { value: string; label: string }[]
		  }
		| {
				kind: 'object'
				name: string
				label?: string
				depth?: number
				fields: readonly FieldNode[]
		  },
): FieldNode {
	return {
		...input,
		path: input.name ?? '$',
		depth: input.depth ?? 0,
		meta: { label: input.label ?? titleCase(input.name ?? 'value') },
		required: false,
		nullable: false,
	} as FieldNode
}

function titleCase(value: string) {
	return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

function button(container: ParentNode, text: string): HTMLButtonElement {
	const match = [...container.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === text,
	)
	if (!match) throw new Error(`button not found: ${text}`)
	return match
}

async function click(element: HTMLElement) {
	await act(async () => element.click())
}

async function change(input: HTMLInputElement, value: string) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
		setter?.call(input, value)
		input.dispatchEvent(new Event('input', { bubbles: true }))
	})
}

async function submit(form: HTMLFormElement) {
	await act(async () => {
		form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
	})
}

async function tick() {
	await act(async () => {
		await Promise.resolve()
		await Promise.resolve()
	})
}
