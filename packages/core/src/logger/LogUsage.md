# LogTape Logging Rules (Best Practices) — Codex/Audit Spec

This spec is optimized for automated review: it focuses on **correct LogTape call forms**, **when to use each**, and **high-signal mistakes with safe fixes**. (All LogTape-behavior claims are taken from official docs.) ([JSR][1])

---

## 1) Canonical call forms (the only forms allowed in new code)

LogTape logging methods (`trace/debug/info/warn/error/fatal`) have four canonical overload shapes. ([JSR][1])

**Pluxel note (compatibility):** our `LoggerService`/`callLogtape()` layer may accept a few *legacy* argument orders for backward compatibility, but they are not considered best practice and should not be used in new code.

### Form A — Tagged template (message only; *no structured fields*)

```ts
logger.info`Loaded plugin ${id} in ${ms}ms`;
```

### Form B — Method call with message + optional properties (structured)

```ts
logger.info("Loaded plugin {id} in {ms}ms", { id, ms });
logger.debug("Stats {*}", () => ({ stats: expensiveStats() })); // lazy properties
```

### Form C — Properties-only (structured; no message; **not lazy**)

```ts
logger.debug({ id, ms, status });
```

### Form D — Lazy logging callback (defers expensive interpolation)

```ts
logger.debug(l => l`Snapshot ${expensiveDump()}`);
```

Lazy evaluation via callback and via properties function is documented in the Quick Start and Structured Logging docs. ([logtape.org][2])

---

## 2) Default decision rule (what Codex should enforce)

### Prefer structured logs for anything operational

Use **Form B (message + properties)** when logs should be filterable/searchable/processable. Placeholders `{key}` are populated from properties, while properties remain structured. ([logtape.org][3])

### Use tagged templates only for “human text”

Template literals currently **cannot include structured data**, so they must not be used when you need fields. ([logtape.org][3])

### Anything expensive must be lazy

* Expensive interpolation → **Form D**
* Expensive properties building → **Form B with `() => ({...})`** ([logtape.org][2])

---

## 3) Structured logging rules (Form B / Form C)

### LT-S001 — Use placeholders `{key}` for fields you want to preserve

```ts
logger.info("Guard {action}", { action: existing ? "updated" : "registered" });
logger.warn("User {username} (ID: {userId}) logged in", { username, userId });
```

Placeholders pull from properties and keep the fields structured. ([logtape.org][3])

### LT-S002 — Use `{*}` to render all properties while keeping them structured

```ts
logger.debug("ctx {*}", { pluginId, reqId, phase });
```

`{*}` includes all properties in the rendered message; properties remain available as structured data. ([logtape.org][3])

### LT-S003 — Properties-only shorthand is equivalent to `{*}`, but is **not lazy**

```ts
logger.info({ userId, username, loginTime });
// equivalent to:
logger.info("{*}", { userId, username, loginTime });
```

This equivalence is explicit in the docs. ([logtape.org][3])

**Codex check**: if any value in a properties-only call is expensive, require converting to lazy properties (Form B with function).

---

## 4) Lazy evaluation rules (performance correctness)

### LT-P001 — Expensive interpolation must not run when level is disabled

**Bad (eager execution):**

```ts
logger.debug`Snapshot ${expensiveDump()}`;
```

**Good (lazy callback):**

```ts
logger.debug(l => l`Snapshot ${expensiveDump()}`);
```

Lazy callback is documented as the intended pattern. ([logtape.org][2])

### LT-P002 — Expensive properties must be supplied by a function

**Bad (eager execution):**

```ts
logger.debug("Stats {*}", { stats: expensiveStats() });
```

**Good (lazy properties):**

```ts
logger.debug("Stats {*}", () => ({ stats: expensiveStats() }));
```

Lazy properties functions are explicitly supported and only called if the level is enabled. ([logtape.org][3])

### LT-P003 — Never try to make properties-only shorthand lazy (it can’t be)

If you need laziness, you must use Form B (message + `() => props`). This is enforced by the method signatures. ([JSR][1])

---

## 5) Template literal rules (Form A) — correctness + constraints

### LT-T001 — Tagged templates cannot carry structured data

If you need fields, use a method call with an object (Form B / Form C). ([logtape.org][3])

### LT-T002 — Use templates for simple, readable interpolation only

```ts
logger.info`Loaded plugin ${id} in ${ms}ms`;
```

**Audit note (style, not a LogTape constraint):** avoid putting an entire message inside one `${...}` expression; it reduces readability and makes review harder.

---

## 6) Placeholder semantics (audit footguns)

### LT-H001 — Escaping `{` uses double braces `{{`

```ts
logger.debug("This logs {{single}} curly braces.");
```

Documented in Structured Logging. ([logtape.org][3])

### LT-H002 — Placeholders may contain leading/trailing spaces

`{ username }` matches `username` **unless** there is an exact `" username "` property; exact match wins. ([logtape.org][3])

**Codex rule**: still prefer `{username}` (no spaces) to avoid surprising collisions.

### LT-H003 — Nested property access is supported in placeholders (1.2.0+)

Supported patterns include:

* dot notation: `{user.name}`
* array index: `{users[0]}`
* bracket notation for special keys: `{user["full-name"]}`
* optional chaining: `{user?.profile?.email}`

Missing paths resolve to `undefined` (and optional chaining avoids failures). ([logtape.org][3])

---

## 7) Contexts (correlation fields) — preferred patterns

### LT-C001 — Use explicit contexts for repeated fields

```ts
const base = getLogger(["app", "module"]);
const ctx = base.with({ reqId, userId });

ctx.info("Start {op}", { op });
ctx.info("Done {op}", { op });
```

`with()` sets explicit context, and placeholders can read context values. ([logtape.org][4])

### LT-C002 — Child loggers inherit context

```ts
const parent = getLogger(["app"]).with({ reqId });
const child = parent.getChild(["module"]);
child.debug("ctx {reqId}");
```

Inheritance is documented. ([logtape.org][4])

### LT-C003 — Implicit contexts require `contextLocalStorage` and are runtime-dependent

* Without `contextLocalStorage`, implicit contexts are not applied and LogTape warns via meta logger.
* In browsers, implicit contexts are typically not available; prefer explicit `with()` context. ([logtape.org][4])

---

## 8) Categories (module identity, not string prefixes)

### LT-G001 — Use hierarchical categories; do not embed `[Module]` into messages

Categories are hierarchical, and dispatch is based on prefix matches; this is the basis for configuration by category. ([logtape.org][5])

```ts
const logger = getLogger(["my-app", "auth-guard"]);
```

---

## 9) Library author rules (important for audits)

### LT-L001 — Libraries must not call `configure()`

LogTape configuration is the application’s responsibility. ([logtape.org][6])

### LT-L002 — Libraries should namespace their categories

Start categories with the library name to avoid conflicts. ([logtape.org][7])

---

## 10) Codex “Findings” and safe fixes

### Finding A — Tagged template used where structured data is required

**Symptom:** template literal logging, but the log should be filterable/aggregated.

**Fix:** convert to Form B

```ts
// before
logger.info`User ${username} logged in`;

// after
logger.info("User {username} logged in", { username });
```

Template literals cannot include structured fields. ([logtape.org][3])

---

### Finding B — Expensive work inside interpolation or properties

**Symptom:** function calls inside `${...}` or inside `{ ... }` at debug/trace.

**Fix 1 (interpolation):**

```ts
logger.debug(l => l`Snapshot ${expensiveDump()}`);
```

**Fix 2 (properties):**

```ts
logger.debug("Snapshot {*}", () => ({ dump: expensiveDump() }));
```

Lazy evaluation patterns are documented. ([logtape.org][2])

---

### Finding C — Properties-only shorthand contains expensive values

**Symptom:** `logger.debug({ dump: expensiveDump() })`

**Fix:** use lazy properties

```ts
logger.debug("{*}", () => ({ dump: expensiveDump() }));
```

Properties-only calls have no lazy overload. ([JSR][1])

---

### Finding D — Placeholder key contains spaces

**Symptom:** `"Hello { name }"` style placeholders.

**Fix:** normalize to `{name}` (prevents collisions with `" name "` keys).
Whitespace matching rules are documented. ([logtape.org][3])

---

## 11) Pluxel conventions (repo best practices, beyond LogTape docs)

### PLX-E001 — Errors: always pass `error`, and render `{error}`

Prefer a stable template that includes `{error}` for readability, while keeping the actual error object structured for sinks/formatters:

```ts
logger.error("execute failed: {error}", { error });
logger.warn("optional({label}) 清理失败: {error}", { label, error });
```

---

## 12) Suggested ripgrep searches (high-signal)

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

# Legacy object-first signature (avoid in new code; may exist only for compatibility tests)
rg -n "logger\.\w+\(\s*\{[^}]*\}\s*,\s*['\"]" .
```

---

## 13) Minimal “golden templates” (recommended to copy)

```ts
// Human-readable only
logger.info`Loaded plugin ${id} in ${ms}ms`;

// Structured, stable template
logger.info("Loaded plugin {id} in {ms}ms", { id, ms });

// Structured + all fields rendered
logger.debug("ctx {*}", { reqId, pluginId, phase });

// Lazy interpolation
logger.debug(l => l`Snapshot ${expensiveDump()}`);

// Lazy structured fields
logger.debug("Snapshot {*}", () => ({ dump: expensiveDump() }));

// Repeated correlation fields
const ctx = getLogger(["app", "module"]).with({ reqId, userId });
ctx.info("Start {op}", { op });
```

---

[1]: https://jsr.io/%40logtape/logtape/doc/~/LogMethod "LogMethod - @logtape/logtape - JSR"
[2]: https://logtape.org/manual/start "Quick start | LogTape"
[3]: https://logtape.org/manual/struct "Structured logging | LogTape"
[4]: https://logtape.org/manual/contexts "Contexts | LogTape"
[5]: https://logtape.org/manual/categories "Categories | LogTape"
[6]: https://logtape.org/manual/config "Configuration | LogTape"
[7]: https://logtape.org/manual/library "Using in libraries | LogTape"
