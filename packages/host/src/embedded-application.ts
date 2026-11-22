import { snapshotVaultBindings } from '@pluxel/core/internal'
import { startHostApplication } from './application-start'
import type { ApplicationEnvironment, PortableApplication } from './application'
import { assertDataObject } from './config-records'
import { createResolvedHost, type HostOptions } from './host'
import {
	assertApplicationShape,
	snapshotHostDeclarations,
	type SnapshotCoreFacilities,
} from './node-declarations'

type Env = ApplicationEnvironment['env']
const emptyEnv: Env = Object.freeze(Object.create(null))

export type HostInputs<F> = Readonly<{
	env?: Env
	coreConfig?: F
	vaultBindings?: HostOptions['vaultBindings']
}>

export function captureEnv(input?: Env, previous?: Env): Env {
	if (input === undefined) return emptyEnv
	if (input === previous) return previous
	if (Object.prototype.toString.call(input) !== '[object Object]')
		throw new TypeError('[host] env must be a record of strings')
	const keys = Reflect.ownKeys(input)
	if (!keys.length) return emptyEnv
	let match = previous && Object.keys(previous).length === keys.length ? previous : undefined
	for (const key of keys) {
		const property = Object.getOwnPropertyDescriptor(input, key)!
		if (
			typeof key !== 'string' ||
			!property.enumerable ||
			!('value' in property) ||
			(property.value !== undefined && typeof property.value !== 'string')
		)
			throw new TypeError(
				'[host] env requires enumerable string keys and string or undefined values',
			)
		if (match && (!Object.hasOwn(match, key) || property.value !== match[key])) match = undefined
	}
	return match ?? Object.freeze(Object.assign(Object.create(null), input))
}

export function captureFacilities(
	input: HostInputs<HostOptions['coreConfig']>,
	facilities: SnapshotCoreFacilities,
): {
	coreConfig?: ReturnType<SnapshotCoreFacilities>
	vaultBindings?: HostOptions['vaultBindings']
} {
	return {
		coreConfig: input.coreConfig === undefined ? undefined : facilities(input.coreConfig),
		vaultBindings:
			input.vaultBindings === undefined ? undefined : snapshotVaultBindings(input.vaultBindings),
	}
}

export async function startApplicationRoot(
	application: PortableApplication,
	facilities: SnapshotCoreFacilities,
	env: Env,
	runtime: ReturnType<typeof captureFacilities>,
) {
	const startup = Object.freeze({ env })
	const declaration = await application(startup)
	assertApplicationShape(declaration, 'embedded')
	const { options, bindings } = snapshotHostDeclarations(declaration)
	if (bindings.envBindings.length || bindings.fileBindings.length)
		throw new TypeError('[host] envBindings and fileBindings require the Node application loader')
	if (runtime.coreConfig !== undefined && declaration.coreConfig !== undefined)
		throw new TypeError('[host] Supply coreConfig once, in the application or its inputs')
	const { prepare, acceptStartup, launch } = declaration
	const host = await createResolvedHost({
		...options,
		coreConfig: runtime.coreConfig ?? facilities(declaration.coreConfig),
		vaultBindings: runtime.vaultBindings,
	})
	await startHostApplication({ prepare, acceptStartup, launch, startup }, host)
	return host
}

export async function startEmbeddedApplication(
	application: PortableApplication,
	facilities: SnapshotCoreFacilities,
	input: HostInputs<HostOptions['coreConfig']> = {},
) {
	if (typeof application !== 'function') throw new TypeError('[host] Application must be a factory')
	assertDataObject(input, 'startHost inputs', ['env', 'coreConfig', 'vaultBindings'])
	return startApplicationRoot(
		application,
		facilities,
		captureEnv(input.env),
		captureFacilities(input, facilities),
	)
}
