---
packages:
  valibot-form:
    type: patch
---

## Share resolved defaults across the form

Schema defaults are resolved once for the controls, form context and reset, keeping values from dynamic default factories consistent. An explicit `defaultValues: undefined` uses schema defaults just like an omitted option.
