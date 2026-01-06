# LogTape Logging Rules — Codex/Audit Spec (Performance-First + Audit Additions)

> This spec is optimized for automated review (Codex): correct call forms, performance-first decisions, and high-signal mistakes with safe fixes.
> LogTape-behavior claims are based on official docs / JSR signatures.

---
---

## Allowed call forms (only these in new code)

LogTape log methods (`trace/debug/info/warn/error/fatal`) have four canonical overload shapes. ([JSR][7])

### Form A — Tagged template (message-only; no structured fields)

Use for human-readable text when you do **not** need queryable fields.
Template literals currently do **not** support structured data. ([LogTape][1])

```ts
logger.info`Loaded plugin ${id} in ${ms}ms`;
````

### Form B — String message (optionally with structured properties)

String message with **no** props is valid (and often the cheapest for static text). ([LogTape][3])

```ts
logger.info("ready");
logger.info("Guard registered");
```

String message + properties is structured logging (recommended when fields matter). ([LogTape][1])

```ts
logger.info("Loaded plugin {id} in {ms}ms", { id, ms });
```

Lazy properties (only evaluated if the log level is enabled). ([LogTape][1])

```ts
logger.debug("Stats {*}", () => ({ stats: expensiveStats() }));
```

### Form C — Properties-only shorthand (structured; equivalent to `"{*}"`; NOT lazy)

Logging an object as the first argument records those properties as structured data.
`logger.info({ ... })` is explicitly equivalent to `logger.info("{*}", { ... })`. ([LogTape][1])

```ts
logger.debug({ id, ms, status });
```

### Form D — Lazy logging callback (defers expensive interpolation)

Lazy callbacks are evaluated only when the log emits. ([JSR][7])

```ts
logger.debug(l => l`Snapshot ${expensiveDump()}`);
```

---

## Performance-first selection rule (Codex enforced)

### LT-DECISION-001 — If you do not need structured fields, do not pass properties

Passing `{ id, ms, meta }` constructs/transfers structured properties and may cause downstream formatters/sinks to process them (e.g., JSON output includes a `properties` object). ([LogTape][1])

Use:

* Static text → `logger.info("ready")` ([LogTape][3])
* Text + cheap values → tagged template logger.info\`...\` ([LogTape][2])
* Text + expensive values → lazy callback (Form D) ([JSR][7])

### LT-DECISION-002 — If you need queryable fields, use structured logging

Use **Form B** (message + properties) or **Form C** (properties-only) so fields remain available as structured data. ([LogTape][1])

> Audit guidance (non-overriding): operational logs *often* want fields → bias toward Form B/C, but still keep only fields you actually need (and keep heavy ones lazy).

### LT-DECISION-003 — Any expensive work must be expressed lazily

* Expensive interpolation → **Form D**
* Expensive property construction → **Form B with `() => ({...})`**
* Properties-only shorthand (Form C) is never lazy. ([JSR][7])

---

## PLX Error Logging Rules (Formatter-Controlled)

### PLX-ERR-001 — Do NOT render/interpolate errors in the log message
The message must never include an error placeholder or any user-formatted error string. Error presentation is owned by our LoggerService / formatter layer.

**Forbidden:**
- `logger.error("failed: {error}", { error })`
- `logger.error("failed: {err}", { err })`
- ``logger.error`failed: ${error}``
- `logger.error("failed: " + error)`
- `logger.error("failed: " + String(error))`
- `logger.error("failed: " + error.stack)`

**Allowed:**
- `logger.error("failed", { error })`
- `logger.error("failed", { err })`
- `logger.error("execute failed ({op})", { op, error })` *(message may include other non-error fields)*


### PLX-ERR-002 — Errors must be passed as structured properties using ONLY `error` or `err`
To keep sinks/formatters predictable, the error object must be provided as a structured property with the key **exactly** `error` or `err`.

**Rules:**
- Use **one** key only: either `error` or `err` (do not provide both).
- Do not rename it (`exception`, `e`, `cause`, `stack`, etc. are not allowed as the primary error field).
- Do not pre-stringify (`String(error)`, `error.message`, `error.stack`) in the call site; formatting is handled centrally.

**Examples:**
```ts
logger.error("request failed", { error, reqId, url });
logger.warn("cleanup failed", { err, label });
````

### PLX-ERR-003 — Any “heavy” error formatting belongs to the formatter (not call sites)

Call sites must not compute expensive or sensitive error representations (stack trimming, serialization, deep inspection, cause-chain rendering, redaction). The formatter decides what to print and how.

In console output:
- `@pluxel/core/logger` pretty formatter renders `error/err` as a multiline stack block (synchronous, non-interleaving).
- Youch (optional) can be enabled for selected categories (e.g. loader/HMR) when richer rendering is desired.

If extra diagnostics are needed, attach them as separate structured fields (and make them lazy if expensive), while still passing the raw `error/err` field:

```ts
logger.error("execute failed", () => ({ error, debug: expensiveDebug() }));
```

---

## Structured properties semantics (including “extra props” like `meta`)

### LT-PROPS-001 — Properties are always present in the log record; placeholders control what appears in the rendered message

When you pass structured data (as the second argument, or as the first object argument), LogTape includes those keys in the log record’s structured properties. Many sinks/formatters can emit those properties (e.g., JSON Lines includes a `properties` object). ([LogTape][1])

#### Example: extra `meta` is structured, but not interpolated unless referenced

```ts
logger.info("Loaded plugin {id} in {ms}ms", { id, ms, meta });
```

* The rendered message interpolates `{id}` and `{ms}`.
* `meta` remains in `record.properties`; it won’t be inserted into the message unless you reference `{meta}` or `{*}`. ([LogTape][1])

### LT-PROPS-002 — `{*}` renders all properties into the message while keeping them structured

Use `{*}` when you want the message text to include a stringified view of the entire properties object. ([LogTape][1])

```ts
logger.debug("plugin ctx {*}", { id, ms, meta });
```

### LT-PROPS-003 — Properties-only shorthand is the `{*}` shorthand

LogTape treats `logger.info({ ... })` as equivalent to `logger.info("{*}", { ... })`. ([LogTape][1])

### LT-PROPS-004 — Avoid using the property key `"*"`

`{*}` normally expands to a stringified form of `LogRecord.properties`,
**unless** there is a property literally named `"*"`, which changes how `{*}` is resolved.
Avoid using `"*"` as a key to keep `{*}` predictable. ([LogTape][4])

---

## `{*}` best-practice patterns (Codex guidance)

### Good uses

1. Debug/trace context dumps (especially during investigation):

```ts
logger.debug("ctx {*}", { pluginId, reqId, phase, meta });
```

2. Properties-only logs where a message is unnecessary:

```ts
logger.debug({ pluginId, reqId, phase, meta });
```

3. When you want “some text + all fields”:

```ts
logger.info("Loaded plugin, ctx {*}", { id, ms, meta });
```

### Avoid / caution

* High-volume paths: `{*}` can stringify large objects; prefer targeted placeholders `{id}`, `{ms}` and keep heavy data behind lazy props. ([LogTape][1])
* Never build heavy objects eagerly just to dump them with `{*}`; use lazy properties:

```ts
logger.debug("ctx {*}", () => ({ meta: expensiveMeta() }));
```

---

## Common mistakes (with safe fixes)

### LT-ANTI-001 — Using tagged templates when fields are required

Template literals cannot carry structured fields. ([LogTape][1])

Fix:

```ts
// before
logger.info`Loaded plugin ${id} in ${ms}ms`;

// after
logger.info("Loaded plugin {id} in {ms}ms", { id, ms });
```

### LT-ANTI-002 — Eager expensive interpolation

Fix:

```ts
// before
logger.debug`Snapshot ${expensiveDump()}`;

// after
logger.debug(l => l`Snapshot ${expensiveDump()}`);
```

### LT-ANTI-003 — Eager expensive properties (including in Form C)

Fix:

```ts
// before
logger.debug({ meta: expensiveMeta() });

// after
logger.debug("ctx {*}", () => ({ meta: expensiveMeta() }));
```

### LT-ANTI-004 — Placeholder key contains spaces (avoid collisions)

LogTape allows `{ username }` and it usually matches `"username"`, but an exact `" username "` key wins. ([LogTape][1])

Fix (style rule): normalize to `{username}`.

---

## Codex review checklist (fast pass)

1. If a log needs queryable fields → ensure Form B/Form C, not tagged template. ([LogTape][1])
2. If properties are passed but fields aren’t needed → suggest removing props (or switching to Form A / `info("...")`). ([LogTape][3])
3. If any expensive work appears inside `${...}` or inside a props object literal → require lazy callback or lazy props. ([LogTape][1], [JSR][7])
4. If extra props like `meta` are passed → confirm the author intends them to be visible to sinks; remind that they won’t appear in message text unless referenced or `{*}` is used. ([LogTape][1])
5. If `{*}` is used in hot paths → suggest narrowing fields or making props lazy. ([LogTape][1])
6. If placeholders include spaces (`{ key }`) → normalize to `{key}` to avoid surprising collisions. ([LogTape][1])

---

## Placeholder semantics (audit footguns)

### LT-H001 — Escaping `{` uses double braces `{{`

```ts
logger.debug("This logs {{single}} curly braces.");
```

([LogTape][1])

### LT-H002 — Nested property access is supported in placeholders (LogTape 1.2.0+)

Supported patterns include: dot notation, array indexing, bracket notation for special keys, optional chaining, and combinations.
Missing paths resolve to `undefined` (optional chaining avoids failures). ([LogTape][1])

Examples:

```ts
logger.info("User {user.name} logged in", { user: { name: "Alice" } });
logger.info("Admin {users[0].name}", { users: [{ name: "Alice" }] });
logger.info('Full name {user["full-name"]}', { user: { "full-name": "Alice" } });
logger.info("Email {user?.profile?.email}", { user: { name: "Alice" } });
```

### LT-H003 — Prefer `{key}` (no spaces) even though `{ key }` is allowed

Spaces are allowed and have matching precedence rules; avoid them for predictability. ([LogTape][1])

---

## Contexts (correlation fields) — preferred patterns

### LT-C001 — Prefer explicit contexts (`logger.with(...)`) for repeated fields

Explicit contexts are designed to reuse the same properties across multiple log messages. ([LogTape][5])

```ts
const base = getLogger(["app", "module"]);
const ctx = base.with({ reqId, userId });

ctx.info("Start {op}", { op });
ctx.info("Done {op}", { op });
```

> Performance note: context fields are structured properties too—only put fields in context if they’re actually useful downstream.

### LT-C002 — Child loggers inherit explicit context

```ts
const parent = getLogger(["app"]).with({ reqId });
const child = parent.getChild(["module"]);
child.debug("ctx {reqId}");
```

([LogTape][5])

### LT-C003 — Implicit contexts are runtime-dependent; browsers don’t support them (as of Nov 2025)

Implicit contexts require `contextLocalStorage` in `configure()`. Without it, LogTape won’t inject implicit context and will warn via meta logger. Web browsers do not support implicit contexts yet (as of November 2025). ([LogTape][5])

---

## Categories (module identity, not string prefixes)

### LT-G001 — Use hierarchical categories; dispatch is based on prefix matches

A category is a list of strings (e.g., `["my-app","my-module"]`), and log dispatch targets loggers whose categories are prefixes. ([LogTape][3])

```ts
const logger = getLogger(["my-app", "auth-guard"]);
```

**Codex style rule:** do not embed `[Module]` into message text—use categories for identity and filtering.

---

## Library author rules (important for audits)

### LT-L001 — Libraries must not call `configure()`

Configuration is the application’s responsibility. ([LogTape][6], [LogTape][2])

### LT-L002 — Libraries should namespace their categories

Start categories with the library name to avoid conflicts. ([LogTape][6])

---

## Suggested ripgrep searches (high-signal)

```bash
# Tagged templates (review whether they should be structured)
rg -n "logger\.\w+`" .

# Properties-only calls (check for expensive values; check if message should exist)
rg -n "logger\.\w+\(\s*\{[\s\S]*\}\s*\)" .

# Expensive-looking calls inside template interpolation
rg -n "logger\.\w+`[^`]*\$\{[^}]*\b(JSON\.stringify|inspect|serialize|dump|format|stack|toJSON)\b" .

# Expensive-looking calls inside properties objects
rg -n "logger\.\w+\([^,]+,\s*\{[^}]*\b(JSON\.stringify|inspect|serialize|dump|format|stack|toJSON)\b" .

# Placeholder whitespace style (prefer {key} over { key })
rg -n "\{\s+\w+|\{\w+\s+\}" .

```

---

## Minimal “golden templates” (recommended to copy)

```ts
// Human-readable only (no structured fields)
logger.info`Loaded plugin ${id} in ${ms}ms`;

// Cheapest static text
logger.info("ready");

// Structured, stable template
logger.info("Loaded plugin {id} in {ms}ms", { id, ms });

// Structured + all fields rendered
logger.debug("ctx {*}", { reqId, pluginId, phase });

// Lazy interpolation (expensive)
logger.debug(l => l`Snapshot ${expensiveDump()}`);

// Lazy structured fields (expensive)
logger.debug("Snapshot {*}", () => ({ dump: expensiveDump() }));

// Error handle
logger.error("failed", { error })
logger.error("failed", { err })
logger.fatal("fatal err", { error })

// Repeated correlation fields
const ctx = getLogger(["app", "module"]).with({ reqId, userId });
ctx.info("Start {op}", { op });
```

---

## References

[1]: https://logtape.org/manual/struct "Structured logging | LogTape"
[2]: https://logtape.org/manual/start "Quick start | LogTape"
[3]: https://logtape.org/manual/categories "Categories | LogTape"
[4]: https://logtape.org/changelog "LogTape changelog"
[5]: https://logtape.org/manual/contexts "Contexts | LogTape"
[6]: https://logtape.org/manual/library "Using in libraries | LogTape"
[7]: https://jsr.io/%40logtape/logtape/doc/~/LogMethod "LogMethod - @logtape/logtape - JSR"
