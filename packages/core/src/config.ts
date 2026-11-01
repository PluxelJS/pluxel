/** Native configuration declarations for Core facilities; independent services configure themselves. */
export { logtape, type LogTapeConfig } from './config/logtape'
export { zenfs } from './config/zenfs'
export type { CoreHostConfig } from './context/Context'
export type { LoggingOptions } from './logging/service'
export type { FsConfig } from './fs/config'
export type { TinyBaseOptions } from './tinybase/types'
