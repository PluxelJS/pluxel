import { resolve } from 'node:path'
import type { HostService, HostStartupContext } from '@pluxel/host'
import { readProductDescriptor, type ProductDescriptor } from './management/product-contract'
import type { ManagementServiceOptions } from './management/service'
import type { ManagementHttpOptions } from './management/http'
import type { WorkbenchInstallOptions } from '@pluxel/workbench/service'
import type { WorkbenchShellOptions } from '@pluxel/workbench/http'
import { elysia } from './elysia'
import { commands } from './commands'
import { nodeModules, type NodeModuleArtifactHostOptions } from './node'
import { workers, type WorkersConfig } from './workers'

type PresetInstallerOptions<Options, Owned extends keyof Options> = Options extends unknown
	? Omit<Options, Owned> & { readonly [Key in Owned]?: never }
	: never

export type ServicesPresetOptions = Readonly<{
	product?: ProductDescriptor
	nodeModules?: PresetInstallerOptions<NodeModuleArtifactHostOptions, 'root'>
	workers?: WorkersConfig
	management?: PresetInstallerOptions<ManagementServiceOptions, 'application' | 'workbench'>
	managementHttp?: PresetInstallerOptions<ManagementHttpOptions, 'bindings'>
	/** Workbench is enabled by default. */
	workbench?:
		| false
		| Readonly<{
				service?: PresetInstallerOptions<WorkbenchInstallOptions, 'product' | 'artifacts'>
				http?: PresetInstallerOptions<WorkbenchShellOptions, 'publicDir'>
		  }>
}>

/** Official application services. Host owns preparation, rollback and shutdown. */
export async function servicesPreset(
	startup: HostStartupContext,
	options: ServicesPresetOptions = {},
): Promise<HostService[]> {
	assertOptionKeys(options, 'options', [
		'product',
		'nodeModules',
		'workers',
		'management',
		'managementHttp',
		'workbench',
	])
	const withWorkbench = options.workbench !== false
	const workbenchOptions = options.workbench === false ? undefined : options.workbench
	const deployment = startup.deployment
	if (withWorkbench && deployment?.variant === 'headless')
		throw new TypeError(
			'[services/preset] Workbench requires a deployment with Workbench artifacts',
		)
	if (workbenchOptions !== undefined)
		assertOptionKeys(workbenchOptions, 'options.workbench', ['service', 'http'])

	const product =
		options.product === undefined
			? undefined
			: readProductDescriptor(options.product, 'options.product')
	const nodeModuleOptions = installerOptions(options.nodeModules, 'options.nodeModules', ['root'])
	const workersOptions = installerOptions(options.workers, 'options.workers')
	const managementOptions = installerOptions(options.management, 'options.management', [
		'application',
		'workbench',
	])
	const managementHttpOptions = installerOptions(options.managementHttp, 'options.managementHttp', [
		'bindings',
	])
	const workbenchServiceOptions = installerOptions(
		workbenchOptions?.service,
		'options.workbench.service',
		['product', 'artifacts'],
	)
	const workbenchHttpOptions = installerOptions(workbenchOptions?.http, 'options.workbench.http', [
		'publicDir',
	])
	const base = [
		elysia(),
		commands(),
		nodeModules(
			deployment?.delivery === 'standalone' && nodeModuleOptions?.resolve === undefined
				? { ...nodeModuleOptions, root: resolve(deployment.root, 'artifacts/node') }
				: nodeModuleOptions,
		),
		workers(workersOptions),
	]
	const [{ managementAccess }, { management }, { managementCommands }, { managementHttp }] =
		await Promise.all([
			import('./management/access'),
			import('./management/service'),
			import('./management/commands'),
			import('./management/http'),
		])
	const workbench = withWorkbench
		? await Promise.all([
				import('@pluxel/workbench/service'),
				import('@pluxel/workbench/http'),
				import('@pluxel/workbench/server'),
			]).then(
				([
					{ workbenchService },
					{ workbenchHttp },
					{ createWorkbenchArtifactHandler, WorkbenchHost },
				]) => ({
					workbenchService,
					workbenchHttp,
					createWorkbenchArtifactHandler,
					WorkbenchHost,
				}),
			)
		: undefined
	const managementTransport = managementHttp({
		...managementHttpOptions,
		...(workbench
			? {
					bindings: (ctx) => ({
						createWorkbench: (principal, invalidate) =>
							ctx.service(workbench.WorkbenchHost).createSession(principal, invalidate),
						artifacts: workbench.createWorkbenchArtifactHandler(ctx),
					}),
				}
			: {}),
	})
	return [
		...base,
		managementAccess(),
		managementCommands(),
		workbench
			? {
					...managementTransport,
					requires: { ...managementTransport.requires, workbench: workbench.WorkbenchHost },
				}
			: managementTransport,
		management({
			...managementOptions,
			application: { product: product ?? null },
			workbench: withWorkbench,
		}),
		...(workbench
			? [
					workbench.workbenchService({
						...workbenchServiceOptions,
						product,
						artifacts: deployment ? { root: resolve(deployment.root, 'workbench') } : undefined,
					}),
					workbench.workbenchHttp({
						...workbenchHttpOptions,
						uiBasePath:
							workbenchHttpOptions?.uiBasePath === undefined
								? '/__pluxel/workbench'
								: workbenchHttpOptions.uiBasePath,
						publicDir: deployment ? resolve(deployment.root, 'workbench/public') : undefined,
					}),
				]
			: []),
	]
}

function optionKeys(input: unknown, label: string): string[] {
	if (
		!input ||
		typeof input !== 'object' ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input))
	)
		throw new TypeError(`[services/preset] ${label} must be an object`)
	return Reflect.ownKeys(input).map((key) => {
		const property = Object.getOwnPropertyDescriptor(input, key)!
		if (typeof key !== 'string' || !property.enumerable || !('value' in property))
			throw new TypeError(`[services/preset] ${label} must contain only enumerable data fields`)
		return key
	})
}

function assertOptionKeys(input: unknown, label: string, allowed: readonly string[]): void {
	for (const key of optionKeys(input, label))
		if (!allowed.includes(key))
			throw new TypeError(`[services/preset] Unknown option ${label}.${key}`)
}

function installerOptions<T>(
	input: T | undefined,
	label: string,
	owned: readonly string[] = [],
): T | undefined {
	if (input === undefined) return undefined
	for (const key of optionKeys(input, label))
		if (owned.includes(key))
			throw new TypeError(`[services/preset] ${label}.${key} is owned by the preset`)
	return { ...input }
}
