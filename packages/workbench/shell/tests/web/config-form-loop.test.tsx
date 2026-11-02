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
	patchPluginConfig = vi.fn(async () => ({
		ok: true as const,
		config: { name: 'saved', enabled: false },
		application: 'applied' as const,
	})),
) {
	return {
		config: {
			patch: patchPluginConfig,
			patchField: vi.fn(),
		},
	} as any
}

function ConfigHarness({
	client,
	savedConfig = EMPTY_CONFIG,
	defaults = EMPTY_CONFIG,
	formFields = fields,
}: {
	client?: ReturnType<typeof createFakeManagementClient>
	savedConfig?: Record<string, unknown>
	defaults?: Record<string, unknown>
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
							readonly={false}
							owner={OWNER}
							displayName="Config owner"
							fields={formFields}
							savedConfig={savedConfig}
							defaults={defaults}
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

describe('single-schema ConfigForm safety', () => {
	it('locks declaration, file and environment fields and submits only the edited unlocked field', async () => {
		const sources = [
			{ owner: OWNER, path: ['limit'], kind: 'declaration' as const, readonly: true },
			{
				owner: OWNER,
				path: ['fileValue'],
				kind: 'file' as const,
				name: 'deployment.json',
				readonly: true,
			},
			{ owner: OWNER, path: ['envValue'], kind: 'env' as const, name: 'APP_VALUE', readonly: true },
			{ owner: OWNER, path: ['nested', 'locked'], kind: 'declaration' as const, readonly: true },
		]
		const controlledFields = applyConfigSources(
			f.extractFormFields(
				v.object({
					name: v.string(),
					limit: v.number(),
					fileValue: v.string(),
					envValue: v.string(),
					untouched: v.optional(v.string(), 'schema default'),
					nested: v.object({ locked: v.string(), editable: v.string() }),
				}),
			),
			sources,
		)
		const patch = vi.fn(async () => ({
			ok: true as const,
			config: { name: 'changed', enabled: false },
			sources,
			readonly: false,
			saved: true as const,
			application: 'applied' as const,
		}))
		const { container, root } = await mount(
			<ConfigHarness
				client={createFakeManagementClient(patch)}
				formFields={controlledFields}
				savedConfig={{
					name: 'saved',
					limit: 100,
					fileValue: 'file',
					envValue: 'env',
					nested: { locked: 'declared nested', editable: 'saved nested' },
				}}
				defaults={{
					name: 'saved',
					untouched: 'schema default',
					nested: { locked: 'ignored default', editable: 'nested default' },
				}}
			/>,
		)
		try {
			for (const key of ['limit', 'fileValue', 'envValue']) {
				const input = container.querySelector<HTMLInputElement>(`input[name="${key}"]`)!
				expect(input.readOnly || input.disabled).toBe(true)
			}
			expect(container.textContent).toContain('由应用声明提供，只读')
			expect(container.textContent).toContain('deployment.json')
			expect(container.textContent).toContain('APP_VALUE')
			await typeIntoInput(
				container.querySelector<HTMLInputElement>('input[name="name"]')!,
				'changed',
			)
			const save = [...container.querySelectorAll('button')].find(
				(button) => button.textContent?.trim() === '保存',
			)!
			await act(async () => {
				save.click()
				await Promise.resolve()
			})
			expect(patch).toHaveBeenCalledWith(OWNER, { name: 'changed' })
			const reset = [...container.querySelectorAll('button')].find(
				(button) => button.textContent?.trim() === '恢复默认',
			)!
			await act(async () => {
				reset.click()
				await Promise.resolve()
			})
			expect(container.querySelector<HTMLInputElement>('input[name="nested.locked"]')!.value).toBe(
				'declared nested',
			)
			expect(
				container.querySelector<HTMLInputElement>('input[name="nested.editable"]')!.value,
			).toBe('nested default')
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('submits one schema against the structured owner address', async () => {
		const patchPluginConfig = vi.fn(async () => ({
			ok: true as const,
			config: { name: 'changed', enabled: false },
			application: 'applied' as const,
		}))
		const { container, root } = await mount(
			<ConfigHarness client={createFakeManagementClient(patchPluginConfig)} />,
		)
		try {
			const input = container.querySelector('input[name="name"]') as HTMLInputElement
			await typeIntoInput(input, 'changed')
			const save = [...container.querySelectorAll('button')].find(
				(button) => button.textContent?.trim() === '保存',
			) as HTMLButtonElement
			expect(save.disabled).toBe(false)
			await act(async () => {
				save.click()
				await Promise.resolve()
				await Promise.resolve()
			})
			expect(patchPluginConfig).toHaveBeenCalledWith(
				OWNER,
				expect.objectContaining({ name: 'changed' }),
			)
		} finally {
			await act(async () => root.unmount())
		}
	}, 30_000)

	it('resets to defaults and reports dirty without a render loop', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const { container, root } = await mount(
			<ConfigHarness
				savedConfig={{ name: 'saved', enabled: false }}
				defaults={{ name: 'default', enabled: false }}
			/>,
		)
		try {
			const reset = [...container.querySelectorAll('button')].find(
				(button) => button.textContent?.trim() === '恢复默认',
			) as HTMLButtonElement
			await act(async () => {
				reset.click()
				await Promise.resolve()
			})
			expect((container.querySelector('input[name="name"]') as HTMLInputElement).value).toBe(
				'default',
			)
			expect(container.querySelector('[data-dirty="true"]')).toBeTruthy()
			expect(error.mock.calls.flat().join('\n')).not.toContain('Maximum update depth exceeded')
		} finally {
			await act(async () => root.unmount())
		}
	})
})
