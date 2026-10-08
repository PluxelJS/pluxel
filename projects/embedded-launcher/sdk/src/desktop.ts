import { Observations, observeAsync } from './observation'
import {
	defineContextCapability,
	installOwnerViewCapability,
	enterOwnerInvocation,
} from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import type { NativeTransport, Json } from './wire'
export interface CommitReceipt {
	committed: true
	message?: string
}
export interface DesktopAction {
	id: string
	title: string
	subtitle: string
}
export const Clipboard = defineContextCapability<{
	write(text: string, signal?: AbortSignal): Promise<CommitReceipt>
}>('launcher.clipboard', { access: 'owner' })
export const Desktop = defineContextCapability<{
	list(signal?: AbortSignal): Promise<readonly DesktopAction[]>
	execute(id: string, signal?: AbortSignal): Promise<CommitReceipt>
}>('launcher.desktop', { access: 'owner' })
function receipt(value: Json): CommitReceipt {
	if (!value || typeof value !== 'object' || Array.isArray(value) || value.committed !== true)
		throw new TypeError('Native operation did not return a committed receipt')
	return {
		committed: true,
		...(typeof value.message === 'string' ? { message: value.message } : {}),
	}
}
export function desktop(transport: NativeTransport, observed = false) {
	return defineHostService({
		name: 'Native desktop',
		capabilities: [
			installOwnerViewCapability(Clipboard, {
				createRoot: () => transport,
				createView: (backend, owner) => {
					const metric = observed
						? owner.root.require(Observations).acquire(owner, 'Clipboard')
						: undefined
					return Object.freeze({
						async write(text: string, signal?: AbortSignal) {
							if (typeof text !== 'string' || text.length > 65536)
								throw new TypeError('Invalid clipboard text')
							const admission = enterOwnerInvocation(owner, signal)
							try {
								return await observeAsync(metric, admission.signal, async () =>
									receipt(await backend.request('clipboard.write', { text }, admission.signal)),
								)
							} finally {
								admission.dispose()
							}
						},
					})
				},
			}),
			installOwnerViewCapability(Desktop, {
				createRoot: () => transport,
				createView: (backend, owner) => {
					const metric = observed
						? owner.root.require(Observations).acquire(owner, 'Desktop')
						: undefined
					return Object.freeze({
						async list(signal?: AbortSignal) {
							const admission = enterOwnerInvocation(owner, signal)
							try {
								return await observeAsync(metric, admission.signal, async () => {
									const value = await backend.request('desktop.list', {}, admission.signal)
									if (
										!value ||
										typeof value !== 'object' ||
										Array.isArray(value) ||
										!Array.isArray(value.actions)
									)
										throw new TypeError('Invalid desktop action list')
									return value.actions.map((item) => {
										if (
											!item ||
											typeof item !== 'object' ||
											Array.isArray(item) ||
											typeof item.id !== 'string' ||
											typeof item.title !== 'string' ||
											typeof item.subtitle !== 'string'
										)
											throw new TypeError('Invalid desktop action')
										return { id: item.id, title: item.title, subtitle: item.subtitle }
									})
								})
							} finally {
								admission.dispose()
							}
						},
						async execute(id: string, signal?: AbortSignal) {
							const admission = enterOwnerInvocation(owner, signal)
							try {
								return await observeAsync(metric, admission.signal, async () =>
									receipt(await backend.request('desktop.execute', { id }, admission.signal)),
								)
							} finally {
								admission.dispose()
							}
						},
					})
				},
			}),
		],
	})
}
