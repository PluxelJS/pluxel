import { type CoreHostConfig } from '@pluxel/core'
import {
	type HostService,
	type HostStateStoreOptions,
	type HostConfigStoreOptions,
} from '@pluxel/host'

/** Isolated service composition; no listener or live development application is created. */
export type ServiceTestHostOptions = Readonly<{
	/** Core lifecycle settings. Defaults to a root named `test`. */
	config?: CoreHostConfig
	/** Complete service list. Omitted installs HTTP, commands, Node artifacts, workers and in-memory persistence. */
	services?: readonly HostService[]
	/** Install the test artifact-backed Workbench and Management. Defaults to false. */
	workbench?: boolean
	/** Install Management without Workbench. Defaults to the Workbench selection; false with workbench:true is rejected. */
	management?: boolean
	/** Isolated graph policy. Defaults to in-memory storage. */
	state?: HostStateStoreOptions
	/** Isolated plugin config. Defaults to in-memory storage. */
	configRecords?: HostConfigStoreOptions
}>
