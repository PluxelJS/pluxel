import { declareApplication, type ApplicationDefinition } from './application-factory'
import type { HostApplication, HostOptions } from './host'

export type ApplicationEnvironment = Readonly<{
	env: Readonly<Record<string, string | undefined>>
}>

type PortableDeclaration<F = HostOptions['coreConfig']> = Omit<
	HostOptions,
	'vaultBindings' | 'coreConfig'
> & { readonly coreConfig?: F } & Pick<
		HostApplication<ApplicationEnvironment>,
		'prepare' | 'acceptStartup' | 'launch'
	> & { readonly sources?: never }

export type PortableApplication<F = HostOptions['coreConfig']> = (
	startup: ApplicationEnvironment,
) => PortableDeclaration<F> | Promise<PortableDeclaration<F>>

/** A portable factory receives the deployment environment for this root. */
export const defineHostApplication: ApplicationDefinition<PortableApplication> = declareApplication

export { defineHostService, type HostService, type HostServiceDependencies } from './services'
export {
	installOwnerViewService,
	installRootService,
	installScopeService,
} from '@pluxel/core/internal'
export { HostApplicationStartupError } from './application-start'
