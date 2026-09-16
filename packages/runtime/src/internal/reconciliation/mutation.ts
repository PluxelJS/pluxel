export {
	type HostStateMutationRejection as RuntimeStateMutationRejection,
	HostStateMutationRejectedError as RuntimeStateMutationRejectedError,
	validateHostStateMutation as validateRuntimeStateMutation,
	applyHostStateMutation as applyRuntimeStateMutation,
} from '@pluxel/host/internal'
