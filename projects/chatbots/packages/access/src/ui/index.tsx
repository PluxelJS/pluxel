import { AccessPanel } from './panel.tsx'
import { accessPlugin } from './runtime.ts'

export default accessPlugin.expose({ AccessPanel, AccessRoute: AccessPanel })
