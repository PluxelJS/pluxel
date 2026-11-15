/** CLI service integration and native console protocol tests. Author operations use /client. */
export {
	DevClientError,
	selectDevInstance,
	connectDevInstance,
	withDevContext,
	type DevInstance,
} from './client/dev'
export { requireDevScripts, resolveDevSelection, type DevProject } from './client/project'
