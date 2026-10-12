import { defineDevConsole } from '@pluxel/host-vite/console'
import { ReportStudioPlugin } from '../src/showcase/ReportStudio'

/** Read-only authority for the browser draft acceptance; never patch or save. */
export default defineDevConsole((dev) => dev.config.get(ReportStudioPlugin))
