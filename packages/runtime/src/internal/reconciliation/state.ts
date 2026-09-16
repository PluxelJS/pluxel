export {
	type HostStatePatchOperation as RuntimeStatePatchOperation,
	type HostStatePatch as RuntimeStatePatch,
	EMPTY_HOST_STATE_PATCH as EMPTY_RUNTIME_STATE_PATCH,
	hostStatePatch as runtimeStatePatch,
	appendHostStatePatch as appendRuntimeStatePatch,
	applyHostStatePatch as applyRuntimeStatePatch,
	hostStateEqual as runtimeStateEqual,
} from '@pluxel/host/internal'
