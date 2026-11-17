import type { RuntimeManagementService } from './services/RuntimeManagementService'
import type { PluginCatalogLayoutService } from './services/management/PluginCatalogLayoutService'
import type { InternalApiValidationService } from './services/http/InternalApiValidationService'
export abstract class Management {
	static readonly access = 'root' as const
}
export interface Management extends RuntimeManagementService {}
export abstract class CatalogLayout {
	static readonly access = 'root' as const
}
export interface CatalogLayout extends PluginCatalogLayoutService {}
export abstract class ApiValidation {}
export interface ApiValidation extends InternalApiValidationService {}
