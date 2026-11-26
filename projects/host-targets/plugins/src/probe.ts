import type { ScriptSdk } from '@pluxel/agent-sdk/host'
import type { PortableApplication } from '@pluxel/host/application'
import { envBinding } from '@pluxel/host/bindings'
import { Consumer, Provider } from './index'
import { HostCapabilities, ProbeVault } from './capabilities'

export { HostCapabilities }

/** Public test data delivered by the deployment, including in a mobile or browser bundle. */
export const probeEnvironment = { HOST_PROBE: 'fixture-binding' } as const

/** The Provider receives configuration and is started through the Consumer's constructor edge. */
export function probePlugins(
	sourceUrl: string,
): NonNullable<Awaited<ReturnType<PortableApplication>>['plugins']> {
	return [
		{ plugin: Provider, config: { source: sourceUrl } },
		{ plugin: Consumer, autoStart: true },
		{
			plugin: HostCapabilities,
			autoStart: true,
			envBindings: [
				envBinding({ vault: { schema: ProbeVault, mapping: { probe: 'HOST_PROBE' } } }),
			],
		},
	]
}

/** Inspect the default session backend. A host without a filesystem supplies its expected errno. */
export async function inspectHost(
	sdk: ScriptSdk,
	options: {
		sourceUrl: string
		expectedSource: string
		sessionFiles?: 'read-write' | 'ENOTSUP'
	},
) {
	const { instance: probe } = await sdk.plugin(HostCapabilities.nodeAddress()).instance()
	const capabilities = await probe.inspect(options.sourceUrl)
	const expected = {
		fetchSource: options.expectedSource,
		wretchSource: options.expectedSource,
		vaultBinding: true,
		vaultWrite: 'READ_ONLY',
		sessionFiles: options.sessionFiles ?? 'read-write',
		durableFiles: 'ENOTSUP',
		durableState: 'DURABILITY_UNAVAILABLE',
		owner: 'package:@pluxel-example/host-targets-plugins/probe::HostCapabilities',
		eventDeliveries: 1,
		effectCleanups: 1,
	}
	for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
		if (capabilities[key] !== expected[key]) {
			throw new Error(
				`HostCapabilities.${key}: expected ${expected[key]}, received ${capabilities[key]}`,
			)
		}
	}

	const { instance: consumer } = await sdk.plugin(Consumer.nodeAddress()).instance()
	const first = await consumer.greet()
	const second = await consumer.greet()
	if (first.source !== options.expectedSource || second.source !== options.expectedSource)
		throw new Error('The injected Provider did not read the configured source')
	if (
		first.visits < 1 ||
		second.visits !== first.visits + 1 ||
		second.generation !== first.generation
	)
		throw new Error('The Provider did not retain the TinyBase counter across calls')

	return { capabilities, first, second }
}
