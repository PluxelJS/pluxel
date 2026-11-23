import type { HostOptions, HostService } from '@pluxel/host'

/** Isolated service composition; no listener or live development application is created. */
export type ServiceTestHostOptions = Pick<
	HostOptions,
	'name' | 'coreConfig' | 'policy' | 'config' | 'pluginNodes' | 'vaultBindings'
> &
	Readonly<{
		/** Complete service list. Omitted installs HTTP, commands, Node artifacts and workers. */
		services?: readonly HostService[]
		/** Install Management without Workbench. Defaults to false. */
		management?: boolean
	}>

/** Framework-only selection of synthetic Workbench artifacts. */
export type ServiceInternalTestHostOptions = ServiceTestHostOptions &
	Readonly<{ workbench?: boolean }>
