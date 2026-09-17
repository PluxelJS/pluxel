import type { PluginConfigRecordSnapshot } from '@pluxel/core/services'
export { HostConfigStore as ConfigService } from '@pluxel/host/internal'
export type { PluginConfigFile } from '@pluxel/host/internal'

export type ConfigServiceMode = 'file' | 'memory' | 'readonly'

export interface ConfigServiceConfig {
	mode?: ConfigServiceMode
	snapshot?: Partial<{
		plugins: readonly PluginConfigRecordSnapshot[]
	}>
	/**
	 * Host startup environment used to initialize a new config store from
	 * the `PLUXEL_CONFIG` structured snapshot.
	 * Static and dynamic Node hosts provide their startup environment when this is omitted;
	 * set `false` only when a custom host must disable environment initialization.
	 * Existing file-backed config remains authoritative.
	 */
	environment?: false | Readonly<Record<string, string | undefined>>
}
