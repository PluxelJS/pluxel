// @vitest-environment jsdom

import { RuntimeManagementClientProvider } from '@pluxel/services/management/react'
import type { PluginNodeAddress } from '@pluxel/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Workbench } from '@worksplit/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as f from 'valibot-form'
import * as v from 'valibot'
import { ConfigForm } from '../src/app/plugins/config/ConfigForm'
import { ManagementQueryProvider } from '../src/app/managementQuery'
import { WorkspaceSession } from '../src/app/workbench/session'
import {
	WorkspaceProviders,
	prepareNativeWorkbenchDom,
	openDocument,
} from './helpers/native-workbench'
import type { RuntimeManagementClient } from '../src/runtime'

const decisions = vi.hoisted(() => [] as { onConfirm?: () => void; onCancel?: () => void }[])
vi.mock('@mantine/modals', async (importOriginal) => ({
	...(await importOriginal<typeof import('@mantine/modals')>()),
	openConfirmModal: (options: (typeof decisions)[number]) => {
		decisions.push(options)
	},
}))
vi.mock('../src/app/log_viewer/LogsPage', () => ({ LogsPage: Configuration }))
vi.mock('../src/app/security/SecurityScreen', () => ({ SecurityScreen: Configuration }))
vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({ WorkspaceNavigation: () => null }))

const owner: PluginNodeAddress = {
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'app', path: 'pluxel-test:ConfigOwner' },
		exportName: 'Plugin',
	},
	variant: 'default',
}
const empty = Object.freeze({ name: '' })
const fields = f.extractFormFields(
	v.object({
		name: v.pipe(
			v.string(),
			f.formMeta({ title: '名称' }),
			f.stringMeta({ placeholder: '输入名称' }),
		),
	}),
)
function Configuration() {
	return (
		<ConfigForm
			owner={owner}
			displayName="Config owner"
			fields={fields}
			savedConfig={empty}
			defaults={empty}
		/>
	)
}

const mounted: Root[] = []
const workspaces: WorkspaceSession[] = []
beforeEach(prepareNativeWorkbenchDom)
afterEach(async () => {
	await act(async () => {
		for (const session of workspaces.splice(0)) await session.dispose()
		for (const root of mounted.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
	window.localStorage.clear()
	window.history.replaceState(null, '', '/')
	decisions.length = 0
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
async function fixture(patch: RuntimeManagementClient['config']['patch']) {
	const session = new WorkspaceSession({ basepath: '/' })
	workspaces.push(session)
	const client = { config: { patch, patchField: vi.fn() } } as unknown as RuntimeManagementClient
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	mounted.push(root)
	await act(async () =>
		root.render(
			<RuntimeManagementClientProvider client={client}>
				<ManagementQueryProvider>
					<WorkspaceProviders session={session}>
						<Workbench workbench={session.workbench} />
					</WorkspaceProviders>
				</ManagementQueryProvider>
			</RuntimeManagementClientProvider>,
		),
	)
	const id = await openDocument(session, '/logs')
	const input = container.querySelector<HTMLInputElement>(
		`[data-worksplit-content="${id}"] input[name="name"]`,
	)!
	expect(input).not.toBeNull()
	return { session, container, id, input }
}
async function type(input: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
		input.dispatchEvent(new Event('input', { bubbles: true }))
		input.dispatchEvent(new Event('change', { bubbles: true }))
	})
}
async function confirm(index = 0) {
	await act(async () => {
		await vi.waitFor(() => expect(decisions[index]).toBeDefined())
		decisions[index]!.onConfirm?.()
	})
}

describe('business configuration save in native documents', () => {
	it('saves two unchanged configuration owners before departure and keeps each copy\u0027s anchors, controls and outline scoped to its mounted form', async () => {
		const warnings = vi.spyOn(console, 'error').mockImplementation(() => {})
		const patch = vi.fn(async (_owner: PluginNodeAddress, config: Record<string, unknown>) => ({
			ok: true as const,
			config,
			sources: [],
			saved: true as const,
			desiredRevision: 1,
			appliedRevision: 1,
			report: {
				catalogRevision: 1,
				runtimeStateRevision: 1,
				reconciliation: [],
				core: { status: 'unchanged' as const },
			},
			application: 'applied' as const,
		}))
		const { session, container, id, input } = await fixture(patch)
		const second = await openDocument(session, '/security')
		const secondScope = container.querySelector<HTMLElement>(
			`[data-worksplit-content="${second}"]`,
		)!
		const secondInput = secondScope.querySelector<HTMLInputElement>('input[name="name"]')!
		const anchors = [...container.querySelectorAll<HTMLElement>('[data-config-anchor]')]
		expect(anchors.length).toBeGreaterThan(1)
		expect(new Set(anchors.map((anchor) => anchor.id)).size).toBe(anchors.length)
		expect(input.id).not.toBe(secondInput.id)
		for (const [documentId, control] of [
			[id, input],
			[second, secondInput],
		] as const) {
			const scope = container.querySelector<HTMLElement>(
				`[data-worksplit-content="${documentId}"]`,
			)!
			expect(control.getAttribute('aria-label')).toBe('名称')
			expect(scope.querySelector(`[id="${control.id}"]`)).toBe(control)
			const ownAnchor = scope.querySelector<HTMLElement>('[data-config-anchor]')!
			expect(ownAnchor.contains(control)).toBe(true)
			const scrollHost = scope.querySelector<HTMLElement>('[data-config-scroll-root]')!
			scrollHost.scrollTo = vi.fn()
			const outline = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
				(item) => item.textContent === '配置目录',
			)!
			await act(async () => {
				outline.click()
			})
			await act(async () => {
				await vi.waitFor(() =>
					expect(
						scope.querySelector('.plx-documentOutline [role="navigation"] button'),
					).not.toBeNull(),
				)
			})
			const button = scope.querySelector<HTMLButtonElement>(
				'.plx-documentOutline [role="navigation"] button',
			)!
			expect(button.textContent).toContain('名称')
			expect(
				scope.querySelectorAll('.plx-documentOutline [role="navigation"] button'),
			).toHaveLength(1)
			await act(async () => button.click())
			expect(scrollHost.scrollTo).toHaveBeenCalledOnce()
		}
		await type(input, 'first saved configuration')
		await type(secondInput, 'second saved configuration')
		window.history.replaceState(null, '', '/security')
		await act(async () => {
			await session.start('/security', false)
		})
		let leaving!: Promise<unknown>
		await act(async () => {
			leaving = session.leave('/security#forms-saved').catch((cause: unknown) => cause)
		})
		await confirm(0)
		await confirm(1)
		await act(async () => {
			expect(await leaving).toBeUndefined()
		})
		await vi.waitFor(() => expect(window.location.hash).toBe('#forms-saved'))
		expect(session.documents.get(id)!.isDirty()).toBe(false)
		expect(session.documents.get(second)!.isDirty()).toBe(false)
		expect(patch).toHaveBeenNthCalledWith(1, owner, { name: 'first saved configuration' })
		expect(patch).toHaveBeenNthCalledWith(2, owner, { name: 'second saved configuration' })
		expect(container.querySelector(`[data-worksplit-content="${id}"] input[name="name"]`)).toBe(
			input,
		)
		expect(secondScope.querySelector('input[name="name"]')).toBe(secondInput)
		expect(warnings).not.toHaveBeenCalled()
	})

	it('keeps a real configuration draft edited after its save while a later workspace departure decision is pending', async () => {
		const patch = vi.fn(async (_owner: PluginNodeAddress, values: Record<string, unknown>) => ({
			ok: true as const,
			config: values,
			sources: [],
			saved: true as const,
			desiredRevision: 1,
			appliedRevision: 1,
			report: {
				catalogRevision: 1,
				runtimeStateRevision: 1,
				reconciliation: [],
				core: { status: 'unchanged' as const },
			},
			application: 'applied' as const,
		}))
		const { session, container, id, input } = await fixture(patch)
		const second = await openDocument(session, '/security')
		const secondInput = container.querySelector<HTMLInputElement>(
			`[data-worksplit-content="${second}"] input[name="name"]`,
		)!
		await type(input, 'first saved config')
		await type(secondInput, 'second config')
		window.history.replaceState(null, '', '/foreign')
		vi.spyOn(console, 'error').mockImplementation(() => {})
		let leaving!: Promise<unknown>
		await act(async () => {
			leaving = session.leave('/security#left').catch((cause: unknown) => cause)
		})
		await confirm(0)
		await vi.waitFor(() => expect(decisions[1]).toBeDefined())
		expect(session.documents.get(id)!.isDirty()).toBe(false)
		await type(input, 'new config during later departure guard')
		await confirm(1)
		await act(async () => {
			expect(await leaving).toMatchObject({ message: expect.stringContaining('退出期间文档') })
		})
		expect(window.location.pathname + window.location.hash).toBe('/security')
		expect(session.documents.get(id)!.isDirty()).toBe(true)
		expect(session.workbench.getDocuments()).toHaveLength(2)
		expect(container.querySelector(`[data-worksplit-content="${id}"] input[name="name"]`)).toBe(
			input,
		)
		expect(input.value).toBe('new config during later departure guard')
		expect(patch).toHaveBeenCalledTimes(2)
	})

	it('publishes dirty from the real form stores, saves its owner and closes only after acknowledgement', async () => {
		let release!: (result: Awaited<ReturnType<RuntimeManagementClient['config']['patch']>>) => void
		const pending = new Promise<Awaited<ReturnType<RuntimeManagementClient['config']['patch']>>>(
			(resolve) => {
				release = resolve
			},
		)
		const patch = vi.fn(() => pending)
		const { session, id, input } = await fixture(patch)
		await type(input, 'saved draft')
		expect(session.documents.get(id)!.isDirty()).toBe(true)
		let closing!: ReturnType<typeof session.workbench.close>
		await act(async () => {
			closing = session.workbench.close(id)
		})
		await confirm()
		expect(patch).toHaveBeenCalledWith(owner, { name: 'saved draft' })
		expect(session.workbench.getDocument(id)).not.toBeNull()
		await act(async () => {
			release({
				ok: true,
				config: { name: 'saved draft' },
				sources: [],
				saved: true as const,
				desiredRevision: 1,
				appliedRevision: 1,
				report: {
					catalogRevision: 1,
					runtimeStateRevision: 1,
					reconciliation: [],
					core: { status: 'unchanged' as const },
				},
				application: 'applied',
			})
			await pending
		})
		await act(async () => {
			const result = await closing
			expect(result.status).toBe('closed')
		})
		expect(session.workbench.getDocuments()).toHaveLength(0)
	})

	it('retains input edited during a pending save and refuses close after the older acknowledgement', async () => {
		let release!: (result: Awaited<ReturnType<RuntimeManagementClient['config']['patch']>>) => void
		const pending = new Promise<Awaited<ReturnType<RuntimeManagementClient['config']['patch']>>>(
			(resolve) => {
				release = resolve
			},
		)
		const { session, container, id, input } = await fixture(vi.fn(() => pending))
		await type(input, 'submitted draft')
		let closing!: ReturnType<typeof session.workbench.close>
		await act(async () => {
			closing = session.workbench.close(id)
		})
		await confirm()
		await type(input, 'newer draft while saving')
		await act(async () => {
			release({
				ok: true,
				config: { name: 'submitted draft' },
				sources: [],
				saved: true as const,
				desiredRevision: 1,
				appliedRevision: 1,
				report: {
					catalogRevision: 1,
					runtimeStateRevision: 1,
					reconciliation: [],
					core: { status: 'unchanged' as const },
				},
				application: 'applied',
			})
			await pending
		})
		await act(async () => expect(await closing).toMatchObject({ status: 'rejected' }))
		expect(session.workbench.getDocument(id)).not.toBeNull()
		expect(session.documents.get(id)!.isDirty()).toBe(true)
		expect(container.querySelector(`input[name="name"]`)).toBe(input)
		expect(input.value).toBe('newer draft while saving')
	})

	it('keeps its real dirty form and input after a transport save failure', async () => {
		const patch = vi.fn(async () => {
			throw new Error('configuration transport unavailable')
		})
		const { session, container, id, input } = await fixture(patch)
		await type(input, 'unsaved configuration')
		let closing!: ReturnType<typeof session.workbench.close>
		await act(async () => {
			closing = session.workbench.close(id)
		})
		await confirm()
		await act(async () => expect(await closing).toMatchObject({ status: 'rejected' }))
		expect(session.workbench.getDocument(id)).not.toBeNull()
		expect(session.documents.get(id)!.isDirty()).toBe(true)
		expect(container.querySelector(`input[name="name"]`)).toBe(input)
		expect(input.value).toBe('unsaved configuration')
	})

	it('checks a real earlier form revision after another document waits and deletes none when that form changes', async () => {
		const patch = vi.fn(async (_owner: PluginNodeAddress, config: Record<string, unknown>) => ({
			ok: true as const,
			config,
			sources: [],
			saved: true as const,
			desiredRevision: 1,
			appliedRevision: 1,
			report: {
				catalogRevision: 1,
				runtimeStateRevision: 1,
				reconciliation: [],
				core: { status: 'unchanged' as const },
			},
			application: 'applied' as const,
		}))
		const { session, container, id: first, input } = await fixture(patch)
		await type(input, 'first configuration')
		const second = await openDocument(session, '/security')
		const secondInput = container.querySelector<HTMLInputElement>(
			`[data-worksplit-content="${second}"] input[name="name"]`,
		)!
		await type(secondInput, 'second configuration')
		let closing!: Promise<boolean>
		await act(async () => {
			closing = session.closeDocuments()
		})
		await confirm(0)
		await vi.waitFor(() => expect(decisions[1]).toBeDefined())
		await type(input, 'first edited after save')
		await confirm(1)
		await act(async () => expect(await closing).toBe(false))
		expect(session.workbench.getDocuments().map((document) => document.id)).toEqual([first, second])
		expect(session.documents.get(first)!.isDirty()).toBe(true)
		expect(input.value).toBe('first edited after save')
		expect(patch).toHaveBeenCalledTimes(2)
	})
})
