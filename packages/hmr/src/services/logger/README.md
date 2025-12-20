# Logger Design

This folder implements the server-side logging pipeline used by the HMR service and plugins.
It favors structured JSON output for persistence and a readable console view for operators.

## Goals

- Preserve stable logger identity per plugin context.
- Provide predictable structured records for UI streaming and file storage.
- Render developer-friendly error output in development while keeping JSON safe.
- Capture caller locations when enabled without breaking production logs.

## Pipeline (end-to-end)

1) `PinoLoggerService` creates a scoped logger per plugin context.
2) `createLogger()` configures:
   - `hooks.logMethod` to normalize payloads and error args (`serialization.ts`).
   - `formatters.log` to add `caller` when enabled (`caller.ts`).
   - `serializers.err` to emit stable error payloads (`serialization.ts`).
3) `pino` writes to a multistream:
   - JSON stream -> `logStore` + rotating log file (`sinks.ts`).
   - Pretty stream -> console (`sinks.ts`).
4) `prettyErrors.ts` intercepts `error`/`fatal` logs in dev and emits Youch output,
   then sanitizes error args so JSON stays compact.

## Key components

- `PinoLoggerService.ts`: binds plugin context into logger bindings and keeps a stable root logger.
- `createLogger.ts`: central factory that wires hooks/formatters/serializers and pretty-error sinks.
- `caller.ts`: captures call-site info and optionally shortens paths via `relativeTo`.
- `serialization.ts`: converts complex values (Map/Set/Buffer/BigInt) into JSON-safe shapes.
- `prettyErrors.ts`: Youch-based pretty error renderer with optional internal-frame filtering.
- `sinks.ts`: JSON stream + pretty stream; JSON stream feeds `logStore`.
- `logStore.ts`: in-memory ring buffer + SSE-friendly subscription.
- `api.ts`: SSE/HTTP endpoint for streaming logs to the UI.
- `logName.ts`: formatting for log display names (plugin id + context name).

## Log record shape

The JSON stream stores a `LogRecord` with at least:

- `time`: ISO string
- `level`: number or string
- `msg`: message string
- `name`: display name (usually `pluginId(ctx.name)`)
- `pluginId`: plugin identifier for filtering
- `context`: `ctx.name` for filtering
- `caller`: optional call-site string (added by `caller.ts`)
- `err`: serialized error object (if present)

## Configuration (env vars)

General:
- `PLUXEL_LOGGER_NAME` / `PLUXEL_LOGGER_LEVEL` / `PLUXEL_LOG_LEVEL` / `LOG_LEVEL`
- `PLUXEL_LOGGER_CALLER` = `0` to disable caller capture
- `PLUXEL_LOGGER_CALLER_ROOT` = absolute path to trim from call sites

Log store:
- `PLUXEL_LOGGER_STORE` = `0` to disable in-memory store
- `PLUXEL_LOGGER_STORE_MIN_LEVEL` = min level kept in the store

Pretty errors (dev-only by default):
- `PLUXEL_LOGGER_PRETTY` / `PLUXEL_YOUCH` = `0` to disable
- `PLUXEL_LOGGER_PRETTY_SKIP_COMPILED` = `0` to show Youch for compiled stacks
- `PLUXEL_LOGGER_PRETTY_COMPILED_HINTS` = `dist,build,lib` (comma-separated)
- `PLUXEL_LOGGER_PRETTY_DUPLEX` = `1` to log pretty errors into the JSON stream
- `PLUXEL_LOGGER_HIDE_INTERNAL` / `PLUXEL_LOGGER_HIDE_INTERNAL_PATTERNS`
- `PLUXEL_LOGGER_KEEP_INTERNAL_FRAMES`

Dumper (object normalization):
- `PLUXEL_LOGGER_DUMP_DEPTH`
- `PLUXEL_LOGGER_DUMP_COLLECTION_LIMIT`
- `PLUXEL_LOGGER_DUMP_TYPED_ARRAY_LIMIT`
- `PLUXEL_LOGGER_DUMP_BUFFER_PREVIEW`
- `PLUXEL_LOGGER_DUMP_STRING_LIMIT`

## Notes / gotchas

- If DI verification fails, `registry.commit()` rolls back, so plugin lists can be empty even
  though logs appear. Fix missing dependencies first.
- Pretty error rendering is skipped for compiled stacks by default to avoid noisy output in `dist/`.
  Use the env vars above to tune this behavior.
