/**
 * Backward-compatible alias.
 *
 * HMR used to override `LoggerService` with an HMR-specific implementation.
 * `@pluxel/core`'s `LoggerService` is now runtime-aware (core vs hmr) and can
 * inject `name` fields for the HMR pretty console prefix without any override.
 */

export type { LoggerServiceConfig as LogtapeLoggerServiceConfig } from '@pluxel/core/logger'
export { LoggerService as LogtapeLoggerService } from '@pluxel/core/services'
