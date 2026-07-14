import { SandboxPanel } from './panel.tsx'
import { sandboxPlugin } from './runtime.ts'

export default sandboxPlugin.expose({ SandboxPanel, SandboxRoute: SandboxPanel })
