// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type { PluginNodeAddress } from '@pluxel/core'
import type { ConfigResult } from '@pluxel/services/management/client'
import { RuntimeManagementClientProvider } from '@pluxel/services/management/react'
import { Workbench } from '@worksplit/react'
import { useQuery } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { extractFormFields } from 'valibot-form'
import * as v from 'valibot'
import { managementQueryKeys, ManagementQueryProvider } from '../../../src/app/managementQuery'
import * as notifyBridge from '../../../src/app/notifications/notifyBridge'
import { ConfigForm } from '../../../src/app/plugins/config/ConfigForm'
import type { PluginConfigSnapshot } from '../../../src/app/plugins/config/usePluginConfig'
import { WorkspaceSession } from '../../../src/app/workbench/session'
import type { RuntimeManagementClient } from '../../../src/runtime'
import { configSnapshot, savedConfig } from './fixtures'
import {
	openDocument,
	prepareNativeWorkbenchDom,
	WorkspaceProviders,
} from '../../fixtures/native-workbench'

vi.mock('../../../src/app/log_viewer/LogsPage', () => ({ LogsPage: Editor }))

const owner: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@fixture/alerts' },
		exportName: 'Alerts',
	},
	variant: 'fork',
	forkId: 'night-shift',
}
const fields = extractFormFields(v.object({ destination: v.string() }))
const sections = [
	{ path: [], fieldName: 'config', fields },
	{
		path: ['delivery'],
		fieldName: 'delivery',
		fields: extractFormFields(v.object({ urgent: v.boolean() })),
	},
]
const initial = { destination: 'on-call', delivery: { urgent: false, channelId: 34 } }
const snapshot = configSnapshot(initial, {
	effectiveInput: { ...initial, destination: 'deployment-default' },
})

function Editor() {
	return (
		<ConfigForm
			owner={owner}
			displayName="Alerts"
			sections={sections.slice(0, 1)}
			snapshot={snapshot}
		/>
	)
}

const cleanups: Array<() => void | Promise<void>> = []
beforeEach(prepareNativeWorkbenchDom)
afterEach(async () => {
	await act(async () => {
		for (const cleanup of cleanups.splice(0).toReversed()) await cleanup()
	})
	document.body.replaceChildren()
	localStorage.clear()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

function surface(config: Partial<RuntimeManagementClient['config']>) {
	const client = { config } as RuntimeManagementClient
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	cleanups.push(() => root.unmount())
	return {
		container,
		render: (content: ReactNode) =>
			act(async () => {
				root.render(
					<RuntimeManagementClientProvider client={client}>
						<ManagementQueryProvider>{content}</ManagementQueryProvider>
					</RuntimeManagementClientProvider>,
				)
			}),
	}
}

function input(scope: ParentNode, name = 'destination') {
	const control = scope.querySelector<HTMLInputElement>(`input[name="${name}"]`)
	if (!control) throw new Error(`Missing configuration field ${name}`)
	return control
}

function managedRadio(scope: ParentNode, name: string, value: string) {
	const control = scope.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)
	if (!control) throw new Error(`Missing boolean choice ${name}: ${value}`)
	return control
}

async function edit(control: HTMLInputElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value)
		control.dispatchEvent(new Event('input', { bubbles: true }))
		control.dispatchEvent(new Event('change', { bubbles: true }))
	})
}

function button(scope: ParentNode, label: string) {
	const control = [...scope.querySelectorAll('button')].find(
		(node) => node.textContent?.trim() === label,
	)
	if (!control) throw new Error(`Missing ${label} control`)
	return control
}

function click(scope: ParentNode, label: string) {
	return act(async () => button(scope, label).click())
}

function showConfig(value: PluginConfigSnapshot, split = false) {
	return (
		<MantineProvider env="test">
			<ConfigForm
				owner={owner}
				displayName="Alerts"
				snapshot={value}
				sections={split ? sections : sections.slice(0, 1)}
			/>
		</MantineProvider>
	)
}

function invalidConfig(message: string): Extract<ConfigResult, { code: 'validation_failed' }> {
	return {
		ok: false,
		code: 'validation_failed',
		state: 'unchanged',
		message,
		readonly: false,
		mode: snapshot.mode,
		managedInput: snapshot.managedInput,
		effectiveInput: snapshot.effectiveInput,
		sources: [],
		shadowedPaths: [],
		managedRevision: snapshot.managedRevision,
		errors: { _root: { destination: [{ path: ['destination'], message }] } },
	}
}

it('submits only editable changes to the selected fork and keeps input while the operator corrects a rejected field', async () => {
	const patch = vi
		.fn<RuntimeManagementClient['config']['patch']>()
		.mockResolvedValueOnce(invalidConfig('Unknown destination'))
		.mockResolvedValueOnce(
			savedConfig({ destination: 'dispatch', delivery: { urgent: true, channelId: 34 } }),
		)
	const { container, render } = surface({ patch })
	await render(showConfig(snapshot, true))
	const destination = input(container)
	const urgent = managedRadio(container, 'urgent', 'on')
	expect(destination.value).toBe('on-call')
	await edit(destination, 'spelling-error')
	await act(async () => urgent.click())
	await click(container, '全部保存')
	expect(container.textContent).toContain('Unknown destination')
	expect(destination.value).toBe('spelling-error')
	expect(urgent.checked).toBe(true)

	await edit(destination, 'dispatch')
	await click(container, '全部保存')
	expect(patch).toHaveBeenLastCalledWith(
		owner,
		{
			set: { destination: 'dispatch', delivery: { urgent: true } },
		},
		{ expectedManagedRevision: 'config:initial' },
	)
	expect(button(container, '全部保存').disabled).toBe(true)
})

it('keeps a dirty section until its own native submit can use the preceding write revision', async () => {
	const pending = Promise.withResolvers<ConfigResult>()
	const saved = { ...initial, destination: 'dispatch' }
	const patch = vi
		.fn<RuntimeManagementClient['config']['patch']>()
		.mockReturnValueOnce(pending.promise)
		.mockResolvedValueOnce(savedConfig({ ...saved, delivery: { ...saved.delivery, urgent: true } }))
	const { container, render } = surface({ patch })
	await render(showConfig(snapshot, true))
	const destination = input(container)
	const urgent = managedRadio(container, 'urgent', 'on')
	await edit(destination, 'dispatch')
	await act(async () => urgent.click())
	const submit = (field: HTMLInputElement) =>
		field.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
	await act(async () => {
		submit(destination)
		submit(urgent)
	})
	expect(patch).toHaveBeenCalledExactlyOnceWith(
		owner,
		{
			set: { destination: 'dispatch' },
		},
		{ expectedManagedRevision: 'config:initial' },
	)
	await act(async () => pending.resolve(savedConfig(saved)))
	expect(urgent.checked).toBe(true)
	expect(container.textContent).toContain('待保存 1')
	await act(async () => submit(urgent))
	expect(patch).toHaveBeenNthCalledWith(
		2,
		owner,
		{
			set: { delivery: { urgent: true } },
		},
		{ expectedManagedRevision: 'config:saved' },
	)
})

it('does not apply validation errors from a submitted value after the operator has already corrected it', async () => {
	const pending = Promise.withResolvers<ConfigResult>()
	const patch = vi
		.fn<RuntimeManagementClient['config']['patch']>()
		.mockReturnValueOnce(pending.promise)
		.mockResolvedValueOnce(savedConfig({ ...initial, destination: 'corrected' }))
	const { container, render } = surface({ patch })
	await render(showConfig(snapshot, true))
	await edit(input(container), 'mistake')
	await click(container, '全部保存')
	expect(patch).toHaveBeenCalledOnce()
	await edit(input(container), 'corrected')
	await act(async () => pending.resolve(invalidConfig('Earlier validation failure')))
	expect(container.textContent).not.toContain('Earlier validation failure')
	expect(input(container).value).toBe('corrected')
	await vi.waitFor(() => expect(button(container, '全部保存').disabled).toBe(false))
	await click(container, '全部保存')
	expect(patch).toHaveBeenNthCalledWith(
		2,
		owner,
		{ set: { destination: 'corrected' } },
		{ expectedManagedRevision: 'config:initial' },
	)
})

it('lets an operator repair a stored invalid input, while a readonly owner admits no submission', async () => {
	const patch = vi.fn<RuntimeManagementClient['config']['patch']>(async () =>
		savedConfig({ destination: 'dispatch' }),
	)
	const { container, render } = surface({ patch })
	const invalid = invalidConfig('Saved destination is unavailable')
	await render(showConfig({ ...invalid, readonly: true }))
	const destination = input(container)
	expect(destination.matches(':disabled')).toBe(true)
	await act(async () =>
		destination.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
	)
	expect(patch).not.toHaveBeenCalled()
	await render(showConfig(invalid))
	expect(container.textContent).toContain('Saved destination is unavailable')
	await edit(input(container), 'dispatch')
	await act(async () => {
		destination.focus()
		destination.dispatchEvent(
			new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
		)
	})
	expect(patch).toHaveBeenCalledOnce()
	expect(button(container, '保存').disabled).toBe(true)
})

it('keeps the confirmed save when the plugin read model fails to refresh', async () => {
	const refresh = vi.fn().mockResolvedValueOnce([]).mockRejectedValue(new Error('Disconnected'))
	function PluginOverview() {
		useQuery({ queryKey: managementQueryKeys.pluginOverview(), queryFn: refresh })
		return null
	}
	const patch = vi.fn<RuntimeManagementClient['config']['patch']>(async () =>
		savedConfig({ ...initial, destination: 'dispatch' }),
	)
	const notice = vi.spyOn(notifyBridge, 'notifyAndRecord')
	const { container, render } = surface({ patch })
	await render(
		<>
			<PluginOverview />
			{showConfig(snapshot)}
		</>,
	)
	await edit(input(container), 'dispatch')
	await click(container, '保存')
	await vi.waitFor(() =>
		expect(notice).toHaveBeenCalledWith(expect.objectContaining({ title: '配置已保存' })),
	)
	expect(refresh).toHaveBeenCalledTimes(2)
	expect(input(container).value).toBe('dispatch')
	expect(button(container, '保存').disabled).toBe(true)
})

it('retains a dirty draft and its revision when another editor saves first', async () => {
	const patch = vi.fn<RuntimeManagementClient['config']['patch']>(async () => ({
		ok: false,
		code: 'revision_conflict',
		state: 'unchanged',
		message: 'Reload required',
		managedRevision: 'config:external',
	}))
	const { container, render } = surface({ patch })
	await render(showConfig(snapshot))
	await edit(input(container), 'draft')
	await render(
		showConfig(configSnapshot({ destination: 'external' }, { managedRevision: 'config:external' })),
	)
	await click(container, '保存')
	expect(patch).toHaveBeenCalledExactlyOnceWith(
		owner,
		{
			set: { destination: 'draft' },
		},
		{ expectedManagedRevision: 'config:initial' },
	)
	expect(input(container).value).toBe('draft')
	expect(button(container, '保存').disabled).toBe(false)
})

it('adopts an external value when its draft is reverted while another section keeps its edit revision', async () => {
	const external = configSnapshot(
		{ ...initial, destination: 'external' },
		{ managedRevision: 'config:external' },
	)
	const patch = vi
		.fn<RuntimeManagementClient['config']['patch']>()
		.mockResolvedValueOnce({
			ok: false,
			code: 'revision_conflict',
			state: 'unchanged',
			message: 'Reload required',
			managedRevision: external.managedRevision,
		})
		.mockResolvedValueOnce(savedConfig({ ...initial, destination: 'next' }))
	const { container, render } = surface({ patch })
	await render(showConfig(snapshot, true))
	await edit(input(container), 'temporary')
	await act(async () => managedRadio(container, 'urgent', 'on').click())
	await render(showConfig(external, true))
	await edit(input(container), initial.destination)
	expect(input(container).value).toBe('external')
	expect(button(container, '保存').disabled).toBe(true)
	expect(container.textContent).toContain('待保存 1')
	await click(container, '全部保存')
	expect(patch).toHaveBeenCalledExactlyOnceWith(
		owner,
		{ set: { delivery: { urgent: true } } },
		{ expectedManagedRevision: snapshot.managedRevision },
	)
	await act(async () => managedRadio(container, 'urgent', 'off').click())
	expect(button(container, '全部保存').disabled).toBe(true)
	await edit(input(container), 'next')
	await click(container, '保存')
	expect(patch).toHaveBeenLastCalledWith(
		owner,
		{ set: { destination: 'next' } },
		{ expectedManagedRevision: external.managedRevision },
	)
})

it('keeps an edit back to the old baseline while its replacement is being saved', async () => {
	const pending = Promise.withResolvers<ConfigResult>()
	const receipt = savedConfig({ ...initial, destination: 'accepted' })
	const patch = vi
		.fn<RuntimeManagementClient['config']['patch']>()
		.mockReturnValueOnce(pending.promise)
		.mockResolvedValueOnce(savedConfig(initial, { managedRevision: 'config:again' }))
	const { container, render } = surface({ patch })
	await render(showConfig(snapshot))
	await edit(input(container), 'accepted')
	await click(container, '保存')
	await edit(input(container), initial.destination)
	await render(showConfig(receipt))
	expect(input(container).value).toBe(initial.destination)
	await act(async () => pending.resolve(receipt))
	expect(input(container).value).toBe(initial.destination)
	expect(button(container, '保存').disabled).toBe(false)
	await click(container, '保存')
	expect(patch).toHaveBeenLastCalledWith(
		owner,
		{ set: { destination: initial.destination } },
		{ expectedManagedRevision: receipt.managedRevision },
	)
	expect(button(container, '保存').disabled).toBe(true)
})

it('keeps record row moves local while persisting edits to their original keys', async () => {
	const recordFields = extractFormFields(v.object({ labels: v.record(v.string(), v.string()) }))
	const labels = { first: 'alpha', second: 'beta' }
	const changed = { first: 'alpha', second: 'new beta' }
	const patch = vi
		.fn<RuntimeManagementClient['config']['patch']>()
		.mockResolvedValue(savedConfig({ labels: changed }))
	const { container, render } = surface({ patch })
	await render(
		<MantineProvider env="test">
			<ConfigForm
				owner={owner}
				displayName="Labels"
				snapshot={configSnapshot({ labels })}
				sections={[{ path: [], fieldName: 'config', fields: recordFields }]}
			/>
		</MantineProvider>,
	)
	const rowValues = () =>
		[...container.querySelectorAll<HTMLInputElement>('input[name^="labels."]')].map(
			(element) => element.value,
		)
	expect(rowValues()).toEqual(['alpha', 'beta'])
	await act(async () =>
		container.querySelectorAll<HTMLButtonElement>('button[aria-label="上移"]')[1]!.click(),
	)
	expect(rowValues()).toEqual(['beta', 'alpha'])
	expect(button(container, '保存').disabled).toBe(true)
	expect(patch).not.toHaveBeenCalled()
	await edit(input(container, 'labels.second'), 'new beta')
	await click(container, '保存')
	expect(patch).toHaveBeenCalledExactlyOnceWith(
		owner,
		{ remove: [['labels']], set: { labels: changed } },
		{ expectedManagedRevision: snapshot.managedRevision },
	)
})

it('restores inheritance for visible settings without copying the effective value into the editor', async () => {
	const reset = vi.fn<RuntimeManagementClient['config']['reset']>(async () =>
		savedConfig(
			{ delivery: initial.delivery },
			{ effectiveInput: { destination: 'deployment-default' } },
		),
	)
	const { container, render } = surface({ reset })
	await render(showConfig(snapshot))
	await click(container, '恢复继承')
	expect(reset).toHaveBeenCalledExactlyOnceWith(owner, [['destination']], {
		expectedManagedRevision: 'config:initial',
	})
	expect(input(container).value).toBe('')
	expect(button(container, '保存').disabled).toBe(true)
})

it('shows inherited, shadowed off, and inherited again for a managed boolean', async () => {
	const managerFields = extractFormFields(
		v.object({
			ignoreScripts: v.pipe(v.optional(v.boolean(), true), v.title('Ignore dependency scripts')),
			minimumReleaseAgeMinutes: v.optional(v.number(), 1440),
		}),
	)
	const managed = { minimumReleaseAgeMinutes: 90 }
	const effective = { ...managed, ignoreScripts: true }
	const origin = {
		mode: 'declared-first' as const,
		effectiveInput: effective,
		config: effective,
		sources: [{ kind: 'declaration' as const, owner, path: ['ignoreScripts'], readonly: false }],
	}
	const managerBefore = configSnapshot(managed, origin)
	const off = savedConfig(
		{ ...managed, ignoreScripts: false },
		{
			...origin,
			shadowedPaths: [['ignoreScripts']],
		},
	)
	const inherited = savedConfig(managed, { ...origin, managedRevision: 'config:inherited' })
	const patch = vi
		.fn<RuntimeManagementClient['config']['patch']>()
		.mockResolvedValueOnce(off)
		.mockResolvedValueOnce(inherited)
	const { container, render } = surface({ patch })
	const show = (managerSnapshot: PluginConfigSnapshot) => (
		<MantineProvider env="test">
			<ConfigForm
				owner={owner}
				displayName="Package Manager"
				snapshot={managerSnapshot}
				sections={[{ path: [], fieldName: 'config', fields: managerFields }]}
			/>
		</MantineProvider>
	)
	const choice = (value: 'inherit' | 'off') => managedRadio(container, 'ignoreScripts', value)
	await render(show(managerBefore))
	expect(choice('inherit').checked).toBe(true)
	await act(async () => choice('off').click())
	await click(container, '保存')
	expect(patch).toHaveBeenNthCalledWith(
		1,
		owner,
		{
			set: { ignoreScripts: false },
		},
		{ expectedManagedRevision: managerBefore.managedRevision },
	)
	await render(show(off))
	expect(choice('off').checked).toBe(true)
	expect(container.textContent).toContain('部分保存值被应用声明覆盖')
	expect(container.textContent).toContain('当前生效值来自应用声明')
	expect(container.textContent).toContain('当前有效输入：true')
	await act(async () => choice('inherit').click())
	await click(container, '保存')
	expect(patch).toHaveBeenNthCalledWith(
		2,
		owner,
		{
			remove: [['ignoreScripts']],
		},
		{ expectedManagedRevision: off.managedRevision },
	)
	await render(show(inherited))
	expect(choice('inherit').checked).toBe(true)
	expect(input(container, 'minimumReleaseAgeMinutes').value).toBe('90')
})

it.each([null, {}])(
	'restores an explicitly saved %j from the active section only',
	async (opts) => {
		const featureFields = extractFormFields(
			v.object({
				opts: v.optional(v.nullable(v.object({ tag: v.optional(v.string()) }))),
				opaqueRows: v.array(v.object({ value: v.unknown() })),
			}),
		)
		const unchanged = {
			feature: { opaqueRows: [{ value: { future: 'saved' } }] },
			other: 'keep',
		}
		const reset = vi
			.fn<RuntimeManagementClient['config']['reset']>()
			.mockResolvedValue(savedConfig(unchanged))
		const { container, render } = surface({ reset })
		await render(
			<MantineProvider env="test">
				<ConfigForm
					owner={owner}
					displayName="Alerts"
					snapshot={configSnapshot({ ...unchanged, feature: { ...unchanged.feature, opts } })}
					sections={[{ path: ['feature'], fieldName: 'settings', fields: featureFields }]}
				/>
			</MantineProvider>,
		)
		expect(container.textContent).toContain('无法编辑的子项')
		await click(container, '恢复继承')
		expect(reset).toHaveBeenCalledExactlyOnceWith(owner, [['feature', 'opts']], {
			expectedManagedRevision: 'config:initial',
		})
	},
)

it('attaches a Part issue to its own occurrence and summarizes a literal path once', async () => {
	const partFields = extractFormFields(
		v.object({ connections: v.array(v.object({ host: v.string() })) }),
	)
	const partSections = ['east', 'west'].map((part) => ({
		path: [part],
		fieldName: 'settings',
		fields: partFields,
	}))
	const saved = {
		east: { connections: [{ host: 'east' }] },
		west: { connections: [{ host: 'west' }] },
	}
	const patch = vi.fn<RuntimeManagementClient['config']['patch']>().mockResolvedValue({
		...invalidConfig('Invalid configuration'),
		errors: {
			west: {
				connections: [
					{ path: ['west', 'connections', 0, 'host'], message: 'West host is invalid' },
					{ path: ['west', 'connections', '0', 'host'], message: 'Literal key is invalid' },
				],
			},
		},
	})
	const { container, render } = surface({ patch })
	await render(
		<MantineProvider env="test">
			<ConfigForm
				owner={owner}
				displayName="Alerts"
				snapshot={configSnapshot(saved)}
				sections={partSections}
			/>
		</MantineProvider>,
	)
	const [east, west] = container.querySelectorAll<HTMLInputElement>(
		'input[name="connections[0].host"]',
	)
	await edit(east!, 'edited east')
	await edit(west!, 'edited west')
	await click(container, '全部保存')
	expect(east!.getAttribute('aria-invalid')).not.toBe('true')
	expect(west!.getAttribute('aria-invalid')).toBe('true')
	expect(container.textContent?.match(/West host is invalid/g)).toHaveLength(1)
	expect(container.textContent?.match(/Literal key is invalid/g)).toHaveLength(1)
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		'$.west.connections["0"].host · Literal key is invalid',
	)
	expect(container.querySelector('[role="alert"]')?.textContent).not.toContain(
		'West host is invalid',
	)
})

async function workspaceEditor(patch: RuntimeManagementClient['config']['patch']) {
	const session = new WorkspaceSession({ basepath: '/' })
	const { container, render } = surface({ patch })
	cleanups.push(() => session.dispose())
	await render(
		<WorkspaceProviders session={session}>
			<Workbench instance={session.workbench} />
		</WorkspaceProviders>,
	)
	const id = await openDocument(session, '/logs')
	const control = (documentId: string) =>
		input(container.querySelector(`[data-worksplit-content="${documentId}"]`)!)
	return { session, id, control }
}

async function confirmClose() {
	await vi.waitFor(() => expect(button(document, '保存并继续')).toBeDefined())
	await click(document, '保存并继续')
}

it('closes a reverted document directly without issuing a save', async () => {
	const patch = vi.fn<RuntimeManagementClient['config']['patch']>()
	const { session, id, control } = await workspaceEditor(patch)
	await edit(control(id), 'temporary')
	await edit(control(id), initial.destination)
	expect(session.documents.get(id)?.isDirty()).toBe(false)
	await act(async () =>
		expect(await session.workbench.close(id)).toMatchObject({ status: 'applied' }),
	)
	expect(patch).not.toHaveBeenCalled()
})

it('closes a changed copy only after its write is acknowledged and leaves the other draft available', async () => {
	const patch = vi
		.fn<RuntimeManagementClient['config']['patch']>()
		.mockRejectedValueOnce(new Error('connection interrupted'))
		.mockResolvedValueOnce(savedConfig({ ...initial, destination: 'dispatch' }))
	const { session, id, control } = await workspaceEditor(patch)
	const copy = await openDocument(session, '/logs', true)
	await edit(control(id), 'operator notes')
	await edit(control(copy), 'dispatch')
	expect(control(id).id).not.toBe(control(copy).id)

	let closing!: ReturnType<typeof session.workbench.close>
	await act(async () => {
		closing = session.workbench.close(copy)
	})
	await confirmClose()
	await act(async () => expect(await closing).toMatchObject({ status: 'denied' }))
	expect(control(copy).value).toBe('dispatch')

	await act(async () => {
		closing = session.workbench.close(copy)
	})
	await confirmClose()
	await act(async () => expect(await closing).toMatchObject({ status: 'applied' }))
	expect(session.workbench.getDocuments().map(({ id: documentId }) => documentId)).toEqual([id])
	expect(control(id).value).toBe('operator notes')
	expect(session.documents.get(id)?.isDirty()).toBe(true)
})

it('blocks close when a user edits again before the earlier save settles', async () => {
	const pending = Promise.withResolvers<ConfigResult>()
	const patch = vi.fn(() => pending.promise)
	const { session, id, control } = await workspaceEditor(patch)
	await edit(control(id), 'initial correction')
	let closing!: ReturnType<typeof session.workbench.close>
	await act(async () => {
		closing = session.workbench.close(id)
	})
	await confirmClose()
	expect(patch).toHaveBeenCalledOnce()
	await edit(control(id), 'newer correction')
	await act(async () => {
		pending.resolve(savedConfig({ ...initial, destination: 'initial correction' }))
		expect(await closing).toMatchObject({ status: 'denied' })
	})
	expect(control(id).value).toBe('newer correction')
	expect(session.documents.get(id)?.isDirty()).toBe(true)
})
