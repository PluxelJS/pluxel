/** Official pluxel command mounting. Metadata is eager; execution and failure dependencies are lazy. */
export {
	scriptCommand,
	devCommonArgs,
	devSubCommands,
	normalizeDevArgs,
	isControlCommandPath,
} from './cli/manifest'
export { validateCommandOptions } from './cli/options'
export { printValue, printDevFailure, printCommandFailure } from './cli/output'
