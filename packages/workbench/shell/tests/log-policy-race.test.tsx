// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import { QueryClientProvider } from '@tanstack/react-query'
import type { PluginNodeAddress } from '@pluxel/core'
import type {
	RuntimeManagementClient,
	VersionedPluginLogPolicySnapshot,
} from '@pluxel/services/management/client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeManagementClientProvider } from '../src/runtime'
import { createManagementQueryClient, managementQueryKeys } from '../src/app/managementQuery'
import { LogPolicyPopover } from '../src/app/log_viewer/LogPolicyPopover'
import { prepareNativeWorkbenchDom } from './helpers/native-workbench'

vi.mock('@mantine/core', async (importOriginal) => {
	const original = await importOriginal<typeof import('@mantine/core')>()
	return {
		...original,
		Select: ({
			value,
			onChange,
			data,
			...props
		}: {
			value: string
			onChange: (value: string) => void
			data: { value: string; label: string }[]
			'aria-label': string
			disabled?: boolean
		}) => (
			<select
				aria-label={props['aria-label']}
				disabled={props.disabled}
				value={value}
				onChange={(e) => onChange(e.currentTarget.value)}
			>
				{data.map((item) => (
					<option key={item.value} value={item.value}>
						{item.label}
					</option>
				))}
			</select>
		),
	}
})
const owner: PluginNodeAddress = {
	definition: { entry: { kind: 'package-root', packageName: '@test/logs' }, exportName: 'Logs' },
	variant: 'default',
}
const key = managementQueryKeys.loggingPolicy()
const initial: VersionedPluginLogPolicySnapshot = {
	version: 3,
	revision: 1,
	persistence: 'clean',
	defaultLevel: 'info',
	overrides: [],
}
const roots: Root[] = []
const clients: ReturnType<typeof createManagementQueryClient>[] = []
beforeEach(prepareNativeWorkbenchDom)
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
	})
	for (const client of clients.splice(0)) client.clear()
	document.body.replaceChildren()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
async function mount(logging: unknown, copies = 1) {
	const query = createManagementQueryClient()
	clients.push(query)
	query.setQueryData(key, initial)
	const root = createRoot(document.body.appendChild(document.createElement('div')))
	roots.push(root)
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<RuntimeManagementClientProvider client={{ logging } as RuntimeManagementClient}>
					<QueryClientProvider client={query}>
						{Array.from({ length: copies }, (_, i) => (
							<LogPolicyPopover key={i} owner={owner} />
						))}
					</QueryClientProvider>
				</RuntimeManagementClientProvider>
			</MantineProvider>,
		),
	)
	await act(async () => {
		document
			.querySelectorAll<HTMLButtonElement>('[aria-label="日志策略"]')
			.forEach((button) => button.click())
	})
	return query
}
function changeDefault(value: string, index = 0) {
	const select = document.querySelectorAll<HTMLSelectElement>(
		'[aria-label="所有插件默认日志级别"]',
	)[index]!
	select.value = value
	select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('log policy cache write ordering', () => {
	it('fences uncancellable reads started before and during a successful write', async () => {
		const before = deferred<VersionedPluginLogPolicySnapshot>()
		const during = deferred<VersionedPluginLogPolicySnapshot>()
		const write = deferred<{ revision: number; persistence: 'clean' }>()
		const getPolicy = vi
			.fn()
			.mockReturnValueOnce(before.promise)
			.mockReturnValueOnce(during.promise)
		const setDefaultLevel = vi.fn().mockReturnValue(write.promise)
		const query = await mount({ getPolicy, setDefaultLevel })
		await act(async () => {
			void query.refetchQueries({ queryKey: key })
			await Promise.resolve()
		})
		await act(async () => changeDefault('debug'))
		expect(setDefaultLevel).toHaveBeenCalledWith(1, 'debug')
		await act(async () => {
			void query.refetchQueries({ queryKey: key })
			await Promise.resolve()
		})
		expect(getPolicy).toHaveBeenCalledTimes(2)
		await act(async () => write.resolve({ revision: 2, persistence: 'clean' }))
		await act(async () => {
			before.resolve(initial)
			during.resolve(initial)
			await Promise.resolve()
		})
		expect(query.getQueryData(key)).toMatchObject({ revision: 2, defaultLevel: 'debug' })
	})

	it('serializes two mounted controls so the queued write uses the preceding committed revision', async () => {
		const first = deferred<{ revision: number; persistence: 'clean' }>()
		const setDefaultLevel = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce({ revision: 3, persistence: 'clean' })
		const query = await mount({ getPolicy: vi.fn(), setDefaultLevel }, 2)
		await act(async () => {
			changeDefault('debug', 0)
			changeDefault('fatal', 1)
		})
		expect(setDefaultLevel.mock.calls).toEqual([[1, 'debug']])
		await act(async () => first.resolve({ revision: 2, persistence: 'clean' }))
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0))
		})
		expect(setDefaultLevel.mock.calls).toEqual([
			[1, 'debug'],
			[2, 'fatal'],
		])
		expect(query.getQueryData(key)).toMatchObject({ revision: 3, defaultLevel: 'fatal' })
	})

	it('reads authority again after a failed write and ignores the pre-failure refresh', async () => {
		const old = deferred<VersionedPluginLogPolicySnapshot>()
		const write = deferred<never>()
		const recovered = { ...initial, revision: 4, defaultLevel: 'warning' as const }
		const getPolicy = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(recovered)
		const query = await mount({
			getPolicy,
			setDefaultLevel: vi.fn().mockReturnValue(write.promise),
		})
		await act(async () => changeDefault('debug'))
		await act(async () => {
			void query.refetchQueries({ queryKey: key })
			await Promise.resolve()
		})
		await act(async () => write.reject(new Error('revision changed')))
		await act(async () => {
			old.resolve(initial)
			await new Promise((resolve) => setTimeout(resolve, 0))
		})
		expect(getPolicy).toHaveBeenCalledTimes(2)
		expect(query.getQueryData(key)).toEqual(recovered)
		expect(document.body.textContent).toContain('revision changed')
	})
})
