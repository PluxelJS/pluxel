// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import type { HostExecutionPolicy, HostPolicyInput } from '@pluxel/host'
import { HOST_POLICY_FIELDS } from '@pluxel/host/internal/protocol'
import type { PolicyResult, RuntimeManagementClient } from '@pluxel/services/management/client'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { HostExecutionPolicy as Editor } from '../src/app/home/HostExecutionPolicy'
import { ManagementQueryProvider } from '../src/app/managementQuery'
import { RuntimeManagementClientProvider } from '../src/runtime'
import { prepareNativeWorkbenchDom } from './helpers/native-workbench'

const appliedExecution: HostExecutionPolicy = {
	startTimeoutMs: 1500,
	drainTimeoutMs: 8000,
	startConcurrency: 8,
	stopConcurrency: 1,
}

function snapshot(revision: string, managedInput: HostPolicyInput = {}): PolicyResult {
	const { startConcurrency, stopConcurrency } = managedInput
	return {
		ok: true,
		readonly: false,
		managedInput,
		effective: {
			...appliedExecution,
			startConcurrency: startConcurrency ?? appliedExecution.startConcurrency,
			stopConcurrency: stopConcurrency ?? appliedExecution.stopConcurrency,
			autoStart: [],
			forks: [],
			providerDefaults: [],
			dependencyOverrides: [],
		},
		mode: Object.fromEntries(HOST_POLICY_FIELDS.map((field) => [field, 'saved-first'])) as Extract<
			PolicyResult,
			{ ok: true }
		>['mode'],
		sources: {
			providerDefaults: 'default',
			startTimeoutMs: 'default',
			drainTimeoutMs: 'default',
			startConcurrency: startConcurrency === undefined ? 'default' : 'saved',
			stopConcurrency: stopConcurrency === undefined ? 'default' : 'saved',
		},
		shadowedFields: [],
		nodeModes: [],
		selections: [],
		managedRevision: revision,
		appliedExecution,
		pendingExecutionFields: [
			...(startConcurrency === undefined ? [] : ['startConcurrency' as const]),
			...(stopConcurrency === undefined ? [] : ['stopConcurrency' as const]),
		],
		application:
			startConcurrency === undefined && stopConcurrency === undefined
				? 'applied'
				: 'requires-host-recreation',
		persistence: { status: 'unchanged' },
	}
}

it('keeps the edited execution budget across a revision conflict and retries only that field', async () => {
	prepareNativeWorkbenchDom()
	const root = createRoot(document.body.appendChild(document.createElement('div')))
	try {
		const get = vi
			.fn()
			.mockResolvedValueOnce(snapshot('policy:first'))
			.mockResolvedValue(snapshot('policy:later', { stopConcurrency: 4 }))
		const patch = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				code: 'revision_conflict',
				state: 'unchanged',
				message: 'Policy changed',
			})
			.mockResolvedValueOnce(snapshot('policy:saved', { startConcurrency: 3, stopConcurrency: 4 }))
		const client = { policy: { get, patch } } as unknown as RuntimeManagementClient
		await act(async () =>
			root.render(
				<MantineProvider env="test">
					<RuntimeManagementClientProvider client={client}>
						<ManagementQueryProvider>
							<Editor />
						</ManagementQueryProvider>
					</RuntimeManagementClientProvider>
				</MantineProvider>,
			),
		)
		await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
		const labeledInput = (text: string) => {
			const label = [...document.querySelectorAll('label')].find(
				(element) => element.textContent === text,
			)!
			return document.getElementById(label.htmlFor) as HTMLInputElement
		}
		const submit = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!
		await vi.waitFor(() => expect(submit()).toBeTruthy())
		const budget = labeledInput('启动并发预算')
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(budget, '3')
			budget.dispatchEvent(new Event('input', { bubbles: true }))
		})
		expect(submit().disabled).toBe(false)
		await act(async () => submit().click())
		await vi.waitFor(() => expect(document.body.textContent).toContain('执行策略版本已变化'))
		expect(labeledInput('启动并发预算').value).toBe('3')
		expect(labeledInput('停止并发预算').value).toBe('4')
		expect(patch).toHaveBeenNthCalledWith(
			1,
			{ startConcurrency: 3, reset: [] },
			{ expectedManagedRevision: 'policy:first' },
		)
		await act(async () => submit().click())
		await vi.waitFor(() =>
			expect(patch).toHaveBeenNthCalledWith(
				2,
				{ startConcurrency: 3, reset: [] },
				{ expectedManagedRevision: 'policy:later' },
			),
		)
		await vi.waitFor(() => expect(submit().disabled).toBe(true))
		expect(document.body.textContent).toContain('当前采用 8，重建后采用 3')
	} finally {
		await act(async () => root.unmount())
		document.body.replaceChildren()
		vi.unstubAllGlobals()
	}
})
