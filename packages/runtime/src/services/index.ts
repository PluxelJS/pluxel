// Always-on runtime services. Optional capabilities such as Vault keep explicit entry points.
import './persistence/PersistenceService'
import './ConfigService'
import './RuntimeStateStore'
import './DatabaseService'
import './http/HttpService'
import './http/InternalApiValidationService'
import './http/InternalGraphQLService'
import './admin-access/AdminAccessService'
import './workbench/WorkbenchService'
import '../node-artifact/NodeModuleService'
import '../node-artifact/WorkerTaskService'
import './CommandsService'
import './commands/AgentToolsService'

/** Context with all always-on runtime service augmentations, without installing them at import sites. */
export type RuntimeServicesContext = import('@pluxel/core').Context
