#!/usr/bin/env sh
set -eu

pnpm exec tsx --conditions=@pluxel/source -e '
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateFiles } from "@gqlens/codegen";
import "./packages/runtime-dynamic/src/api/graphql.ts";
import { createInternalGraphQLSchemaSDL } from "./packages/runtime/src/services/http/internalGraphqlSchema.ts";

void (async () => {
  const ctx = {
    logger: console,
    configService: {
      getExtra() {
        return [];
      },
      setExtra() {},
    },
  };
  const files = await generateFiles({
    schema: createInternalGraphQLSchemaSDL(ctx),
    framework: "react",
  });
  const outputDir = join(process.cwd(), "packages/components/src/app/gqlens");
  for (const [name, content] of Object.entries(files)) {
    const file = join(outputDir, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
})();
'
