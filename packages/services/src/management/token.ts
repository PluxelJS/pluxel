import { defineContextCapability, type ContextCapability } from '@pluxel/core/host'
import type { RuntimeManagementService } from './services/RuntimeManagementService'
import type { PluginCatalogLayoutService } from './services/management/PluginCatalogLayoutService'
import type { InternalApiValidationService } from './services/http/InternalApiValidationService'

export const Management: ContextCapability<RuntimeManagementService, 'root'> =
	defineContextCapability('management.host', { access: 'root', property: 'runtimeManagement' })
export const CatalogLayout: ContextCapability<PluginCatalogLayoutService, 'root'> =
	defineContextCapability('management.catalog-layout', {
		access: 'root',
		property: 'pluginCatalogLayout',
	})
export const ApiValidation: ContextCapability<InternalApiValidationService> =
	defineContextCapability('management.api-validation', {
		access: 'all',
		property: 'internalApiValidation',
	})
declare module '@pluxel/core' {
	interface ContextServices {
		readonly internalApiValidation: InternalApiValidationService
	}
	interface RootContextServices {
		readonly runtimeManagement: RuntimeManagementService
		readonly pluginCatalogLayout: PluginCatalogLayoutService
	}
}
