import {
	createBridgeComponent,
	type DestroyParams,
	type RenderParams,
} from '@module-federation/bridge-react/v19'
import {
	parseWorkbenchDeclarationIdentity,
	workbenchDeclarationIdentityEqual,
	type WorkbenchDeclarationIdentity,
} from '@pluxel/core/federation'
import { useMemo, type ComponentType } from 'react'
import { readWorkbenchOpenedViewHandle } from './opened-view'
import { readWorkbenchDescriptor, type WorkbenchRenderableDescriptor } from './definition'
import {
	WorkbenchReactContextProvider,
	type WorkbenchBridgePayload,
	type WorkbenchHostFacade,
} from './react-context'

const BRIDGE_METADATA = Symbol.for('pluxel.workbench.bridge.provider.profile1')
const BRIDGE_PAYLOAD_FIELD = '__pluxelWorkbench' as const

type WorkbenchBridgeMetadata = Readonly<{
	profile: 1
	descriptor: WorkbenchDeclarationIdentity
}>

export type WorkbenchBridgeProvider = (() => Readonly<{
	render(info: RenderParams): Promise<void>
	destroy(info: DestroyParams): void
}>) &
	Readonly<{ [BRIDGE_METADATA]: WorkbenchBridgeMetadata }>

/** Toolchain-generated Bridge ABI. This entry is not a Plugin author API. */
export function createWorkbenchBridge<Descriptor extends WorkbenchRenderableDescriptor>(
	identityInput: WorkbenchDeclarationIdentity,
	descriptor: Descriptor,
	Renderer: ComponentType,
): WorkbenchBridgeProvider {
	const identity = parseWorkbenchDeclarationIdentity(identityInput)
	const metadata = readWorkbenchDescriptor(descriptor)
	if (
		(metadata.kind !== 'view' && metadata.kind !== 'attachment') ||
		metadata.kind !== identity.kind ||
		metadata.key !== identity.key
	) {
		throw new TypeError('[workbench/react] generated Bridge descriptor identity mismatch')
	}
	if (typeof Renderer !== 'function') {
		throw new TypeError('[workbench/react] renderer must be a zero-props React component')
	}

	function Root(props: Record<string, unknown>) {
		const payload = readBridgePayload(props[BRIDGE_PAYLOAD_FIELD])
		const opened = readWorkbenchOpenedViewHandle(payload.handle)
		if (!workbenchDeclarationIdentityEqual(opened.federatedViewRef.descriptor, identity)) {
			throw new Error('[workbench/react] opened View does not match generated Bridge identity')
		}
		const value = useMemo(
			() =>
				Object.freeze({
					descriptor,
					identity,
					opened,
					host: payload.host,
					...(payload.paneLayoutRenderer === undefined
						? {}
						: { paneLayoutRenderer: payload.paneLayoutRenderer }),
				}),
			[opened, payload.host, payload.paneLayoutRenderer],
		)
		return (
			<WorkbenchReactContextProvider value={value}>
				<Renderer />
			</WorkbenchReactContextProvider>
		)
	}

	const provider = createBridgeComponent({ rootComponent: Root }) as WorkbenchBridgeProvider
	Object.defineProperty(provider, BRIDGE_METADATA, {
		value: Object.freeze({ profile: 1, descriptor: identity }),
		enumerable: false,
	})
	return Object.freeze(provider)
}

export function readWorkbenchBridgeProvider(input: unknown): WorkbenchBridgeProvider {
	if (typeof input !== 'function') {
		throw new TypeError('[workbench/react] remote expose default is not a Bridge provider')
	}
	const metadata = (input as Partial<WorkbenchBridgeProvider>)[BRIDGE_METADATA]
	if (!metadata || metadata.profile !== 1) {
		throw new TypeError('[workbench/react] remote expose is not a Workbench Profile 1 Bridge')
	}
	parseWorkbenchDeclarationIdentity(metadata.descriptor)
	return input as WorkbenchBridgeProvider
}

export function readWorkbenchBridgeIdentity(
	provider: WorkbenchBridgeProvider,
): WorkbenchDeclarationIdentity {
	return provider[BRIDGE_METADATA].descriptor
}

function readBridgePayload(input: unknown): WorkbenchBridgePayload {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('[workbench/react] missing Bridge payload')
	}
	const record = input as Record<string, unknown>
	for (const key of Object.keys(record)) {
		if (!['profile', 'handle', 'host', 'paneLayoutRenderer'].includes(key)) {
			throw new TypeError(`[workbench/react] unsupported Bridge payload field ${key}`)
		}
	}
	if (record.profile !== 1) throw new TypeError('[workbench/react] unsupported Bridge profile')
	const host = readHostFacade(record.host)
	if (record.paneLayoutRenderer !== undefined && typeof record.paneLayoutRenderer !== 'function') {
		throw new TypeError('[workbench/react] invalid Pane Kit renderer')
	}
	return Object.freeze({
		profile: 1,
		handle: record.handle as WorkbenchBridgePayload['handle'],
		host,
		...(record.paneLayoutRenderer === undefined
			? {}
			: {
					paneLayoutRenderer:
						record.paneLayoutRenderer as WorkbenchBridgePayload['paneLayoutRenderer'],
				}),
	})
}

function readHostFacade(input: unknown): WorkbenchHostFacade {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('[workbench/react] invalid host facade')
	}
	const host = input as Partial<WorkbenchHostFacade>
	if (
		typeof host.locale !== 'string' ||
		(host.colorScheme !== 'light' && host.colorScheme !== 'dark') ||
		typeof host.notify !== 'function' ||
		typeof host.confirm !== 'function' ||
		(host.navigation !== null && typeof host.navigation !== 'object') ||
		(host.document !== null && typeof host.document !== 'object')
	) {
		throw new TypeError('[workbench/react] malformed host facade')
	}
	return input as WorkbenchHostFacade
}
