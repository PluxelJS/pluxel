// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type { PluginNodeAddress } from '@pluxel/core'
import { RuntimeManagementClientProvider } from '@pluxel/services/management/react'
import { act, useMemo, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as f from 'valibot-form'
import * as v from 'valibot'
import { ConfigForm } from '../../src/app/plugins/config/ConfigForm'
import { ManagementQueryProvider } from '../../src/app/managementQuery'
import { configSnapshot, savedConfig } from '../helpers/config'
import type { PluginConfigSnapshot } from '../../src/app/plugins/config/usePluginConfig'
import type { RuntimeManagementClient } from '@pluxel/services/management/client'
import { applyConfigSources } from '../../src/app/plugins/config/presentationAdapter'

const OWNER: PluginNodeAddress = {
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'app', path: 'pluxel-test:ConfigOwner' },
		exportName: 'Plugin',
	},
	variant: 'default',
}

const EMPTY_CONFIG = Object.freeze({ name: '', enabled: false })

const schema = v.object({
	name: v.pipe(
		v.string(),
		f.formMeta({ title: '名称' }),
		f.stringMeta({ placeholder: '输入名称' }),
	),
	enabled: v.pipe(v.boolean(), f.formMeta({ title: '启用' })),
})
const fields = f.extractFormFields(schema)

function createFakeManagementClient(
	patch = vi.fn(async () => savedConfig({ name: 'saved', enabled: false })),
	reset = vi.fn(async () => savedConfig({})),
) {
	return { config: { patch, reset } } as unknown as RuntimeManagementClient
}

function ConfigHarness({
	client,
	snapshot = configSnapshot(EMPTY_CONFIG),
	formFields = fields,
}: {
	client?: RuntimeManagementClient
	snapshot?: PluginConfigSnapshot
	formFields?: readonly f.FieldNode[]
}) {
	const [dirty, setDirty] = useState(false)
	const resolvedClient = useMemo(() => client ?? createFakeManagementClient(), [client])
	return (
		<RuntimeManagementClientProvider client={resolvedClient}>
			<ManagementQueryProvider>
				<MantineProvider>
					<div data-dirty={dirty ? 'true' : 'false'}>
						<ConfigForm
							owner={OWNER}
							displayName="Config owner"
							fields={formFields}
							snapshot={snapshot}
							onDirtyChange={setDirty}
						/>
					</div>
				</MantineProvider>
			</ManagementQueryProvider>
		</RuntimeManagementClientProvider>
	)
}

class ResizeObserverMock {
	disconnect() {}
	observe() {}
	unobserve() {}
}

async function typeIntoInput(input: HTMLInputElement, value: string) {
	await act(async () => {
		const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
		descriptor?.set?.call(input, value)
		input.dispatchEvent(new Event('input', { bubbles: true }))
		input.dispatchEvent(new Event('change', { bubbles: true }))
		await Promise.resolve()
	})
}

async function mount(ui: ReactNode) {
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	await act(async () => {
		root.render(ui)
		await Promise.resolve()
	})
	return { container, root }
}

beforeAll(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	globalThis.ResizeObserver = ResizeObserverMock as any
	if (typeof window.matchMedia !== 'function') {
		window.matchMedia = ((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		})) as typeof window.matchMedia
	}
})

afterEach(() => {
	vi.restoreAllMocks()
	document.body.innerHTML = ''
})

async function click(container: HTMLElement, label: string) {
	const button = [...container.querySelectorAll('button')].find(
		(candidate) => candidate.textContent?.trim() === label,
	)!
	expect(button).toBeDefined()
	await act(async () => {
		button.click()
		await Promise.resolve()
	})
}

describe('raw input ConfigForm transactions', () => {
	it('keeps shadowed saved inputs editable without materializing effective values or defaults', async () => {
		const sources = [
			{ owner: OWNER, path: ['name'], kind: 'env' as const, name: 'APP_NAME', readonly: false },
		]
		const snapshot = configSnapshot(
			{ name: 'saved' },
			{
				effectiveInput: { name: 'env', enabled: true },
				config: { name: 'TRANSFORMED', enabled: true },
				sources,
				shadowedPaths: [['name']],
			},
		)
		const patch = vi.fn(async () => savedConfig({ name: 'changed' }))
		const { container, root } = await mount(
			<ConfigHarness
				snapshot={snapshot}
				client={createFakeManagementClient(patch)}
				formFields={applyConfigSources(fields, sources, [], snapshot.effectiveInput)}
			/>,
		)
		try {
			const input = container.querySelector<HTMLInputElement>('input[name="name"]')!
			expect(input.value).toBe('saved')
			expect(input.readOnly || input.disabled).toBe(false)
			expect(container.textContent).toContain('APP_NAME')
			await typeIntoInput(input, 'changed')
			await click(container, '保存')
			expect(patch).toHaveBeenCalledWith(
				OWNER,
				{ set: { name: 'changed' }, remove: [['name']] },
				{ expectedManagedRevision: 'config:initial' },
			)
			expect(input.value).toBe('changed')
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('restores inheritance with one reset transaction and accepts the confirmed raw input', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const reset = vi.fn(async () =>
			savedConfig(
				{},
				{
					effectiveInput: { name: 'inherited', enabled: true },
					config: { name: 'INHERITED', enabled: true },
				},
			),
		)
		const { container, root } = await mount(
			<ConfigHarness
				snapshot={configSnapshot({ name: 'saved', enabled: false })}
				client={createFakeManagementClient(undefined, reset)}
			/>,
		)
		try {
			await click(container, '恢复继承')
			expect(reset).toHaveBeenCalledWith(OWNER, [['name'], ['enabled']], {
				expectedManagedRevision: 'config:initial',
			})
			expect(container.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('')
			expect(container.querySelector('[data-dirty="false"]')).not.toBeNull()
			expect(error.mock.calls.flat().join('\n')).not.toContain('Maximum update depth exceeded')
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('keeps a draft and its original CAS token when a refreshed snapshot arrives', async () => {
		const patch = vi.fn(async () => ({
			ok: false as const,
			code: 'revision_conflict' as const,
			state: 'unchanged' as const,
			message: 'Reload required',
			managedRevision: 'config:external',
		}))
		const client = { config: { patch } } as unknown as RuntimeManagementClient
		const { container, root } = await mount(<ConfigHarness client={client} />)
		try {
			const input = container.querySelector<HTMLInputElement>('input[name="name"]')!
			await typeIntoInput(input, 'my draft')
			await act(async () =>
				root.render(
					<ConfigHarness
						client={client}
						snapshot={configSnapshot(
							{ name: 'external', enabled: true },
							{ managedRevision: 'config:external' },
						)}
					/>,
				),
			)
			expect(input.value).toBe('my draft')
			await click(container, '保存')
			expect(patch).toHaveBeenCalledWith(
				OWNER,
				{ set: { name: 'my draft' }, remove: [['name']] },
				{ expectedManagedRevision: 'config:initial' },
			)
			expect(input.value).toBe('my draft')
			expect(container.querySelector('[data-dirty="true"]')).not.toBeNull()
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('lets invalid saved input be repaired without fabricating parsed output', async () => {
		const {
			config: _config,
			application: _application,
			appliedRevision: _applied,
			desiredRevision: _desired,
			persistence: _persistence,
			report: _report,
			applyFailure: _failure,
			...input
		} = configSnapshot({ name: 'invalid' })
		const snapshot: PluginConfigSnapshot = {
			...input,
			ok: false,
			code: 'validation_failed',
			state: 'unchanged',
			errors: {},
			message: 'Name is invalid',
		}
		const patch = vi.fn(async () => savedConfig({ name: 'repaired' }))
		const { container, root } = await mount(
			<ConfigHarness snapshot={snapshot} client={createFakeManagementClient(patch)} />,
		)
		try {
			expect(container.textContent).toContain('Name is invalid')
			await typeIntoInput(
				container.querySelector<HTMLInputElement>('input[name="name"]')!,
				'repaired',
			)
			await click(container, '保存')
			expect(patch).toHaveBeenCalledOnce()
		} finally {
			await act(async () => root.unmount())
		}
	})
})
