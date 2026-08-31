---
packages:
  '@pluxel/commands':
    type: minor
  '@pluxel/core':
    type: patch
  '@pluxel/runtime':
    type: minor
---

## Add exact command implementations and owner-bound carrier mounts

Export `DirectCommand` for APIs that must retain one concrete implementation instead of a
compatible-replacement catalog handle. Add `ctx.commands.createMount()` so carrier providers can
publish direct commands into their own router or SDK surface while Runtime binds execution and cleanup to
both provider and consumer generations, without introducing a secondary command registry or implicit root
publication.
