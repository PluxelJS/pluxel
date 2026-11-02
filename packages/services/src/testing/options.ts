import { type HostService, type HostRuntimeOptions } from '@pluxel/host'

/** Isolated service composition; no listener or live development application is created. */
export type ServiceTestHostOptions = Readonly<{
	/** Core lifecycle settings. Defaults to a root named `test`. */
	name?: string
	runtime?: HostRuntimeOptions
	/** Complete service list. Omitted installs HTTP, commands, Node artifacts and workers. */
	services?: readonly HostService[]
	/** Install Management without Workbench. Defaults to false. */
	management?: boolean
}>

/** Framework-only selection of synthetic Workbench artifacts. */
export type ServiceInternalTestHostOptions = ServiceTestHostOptions &
	Readonly<{ workbench?: boolean }>
