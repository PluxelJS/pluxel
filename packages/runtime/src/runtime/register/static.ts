// Production static runtime service registration.

import '../../services/persistence/PersistenceService'
import '../../services/ConfigService'
import '../../services/RuntimeStateStore'
import '../../services/PluginDataService'
import '../../services/http/HttpService'
import '../../services/http/InternalApiValidationService'
import '../../services/http/InternalGraphQLService'
import '../../services/verification/VerificationService'
import '../../context-augment'
import '../../events'

import type {} from '../../services/persistence/PersistenceService'
import type {} from '../../services/ConfigService'
import type {} from '../../services/RuntimeStateStore'
import type {} from '../../services/PluginDataService'
import type {} from '../../services/http/HttpService'
import type {} from '../../services/http/InternalApiValidationService'
import type {} from '../../services/http/InternalGraphQLService'
import type {} from '../../services/verification/VerificationService'
import type {} from '../../context-augment'
import type {} from '../../events'

import type { ConfigService } from '../../services/ConfigService'
import type { RuntimeStateStore } from '../../services/RuntimeStateStore'
import type { PluginDataService } from '../../services/PluginDataService'
import type { PersistenceService } from '../../services/persistence/PersistenceService'
import type { HttpService } from '../../services/http/HttpService'
import type { InternalApiValidationService } from '../../services/http/InternalApiValidationService'
import type { InternalGraphQLService } from '../../services/http/InternalGraphQLService'
import type { VerificationService } from '../../services/verification/VerificationService'

export type StaticRuntimeRegisteredServices =
	| ConfigService
	| RuntimeStateStore
	| PluginDataService
	| PersistenceService
	| HttpService
	| InternalApiValidationService
	| InternalGraphQLService
	| VerificationService
