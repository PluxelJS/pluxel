// Production static runtime service registration.

import '../../services/persistence/PersistenceService'
import '../../services/ConfigService'
import '../../services/RuntimeStateStore'
import '../../services/PluginDataService'
import '../../services/http/HttpService'
import '../../services/http/InternalApiValidationService'
import '../../services/http/InternalGraphQLService'
import '../../services/admin-access/AdminAccessService'
import '../../services/workbench/WorkbenchService'
import '../../services/OptionalPluginAvailabilityService'
import '../../context-augment'
import '../../events'

import type { ConfigService } from '../../services/ConfigService'
import type { RuntimeStateStore } from '../../services/RuntimeStateStore'
import type { PluginDataService } from '../../services/PluginDataService'
import type { PersistenceService } from '../../services/persistence/PersistenceService'
import type { HttpService } from '../../services/http/HttpService'
import type { InternalApiValidationService } from '../../services/http/InternalApiValidationService'
import type { InternalGraphQLService } from '../../services/http/InternalGraphQLService'
import type { AdminAccessService } from '../../services/admin-access/AdminAccessService'
import type { WorkbenchService } from '../../services/workbench/WorkbenchService'
import type { OptionalPluginAvailabilityService } from '../../services/OptionalPluginAvailabilityService'

export type StaticRuntimeRegisteredServices =
	| ConfigService
	| RuntimeStateStore
	| PluginDataService
	| PersistenceService
	| HttpService
	| InternalApiValidationService
	| InternalGraphQLService
	| AdminAccessService
	| WorkbenchService
	| OptionalPluginAvailabilityService
