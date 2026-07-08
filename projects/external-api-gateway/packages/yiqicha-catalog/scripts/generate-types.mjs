import { readFile, writeFile } from "node:fs/promises";

const dataUrl = new URL("../data/apis.json", import.meta.url);
const apiCodesUrl = new URL("../src/api-codes.ts", import.meta.url);
const typesUrl = new URL("../src/generated-types.ts", import.meta.url);

export async function writeGeneratedSources(apis) {
  await Promise.all([
    writeFile(apiCodesUrl, generateApiCodes(apis)),
    writeFile(typesUrl, generateTypes(apis)),
  ]);
}

export function getApiEntries(apis) {
  const baseNames = apis.map((api) => {
    const raw =
      new URL(api.apiUrl).pathname.split("/").filter(Boolean).at(-1) ?? `api${api.apiCode}`;
    let key = raw.replace(/[^A-Za-z0-9_$]/g, "");

    if (!/^[A-Za-z_$]/.test(key)) key = `api${api.apiCode}`;

    return { api, key };
  });
  const counts = new Map();

  for (const item of baseNames) {
    counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  }

  return baseNames
    .map(({ api, key }) => ({
      api,
      key: counts.get(key) === 1 ? key : `${key}${api.apiCode}`,
      typeName: toPascalCase(counts.get(key) === 1 ? key : `${key}${api.apiCode}`),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function generateApiCodes(apis) {
  const entries = getApiEntries(apis);

  return [
    "// Generated from data/apis.json. Run `pnpm --filter @repo/yiqicha scrape` and regenerate if the catalog changes.",
    "export const yiqichaApiCodes = {",
    ...entries.map(
      ({ api, key }) =>
        `  /** ${escapeComment(`${api.apiName} ${api.apiUrl}`)} */\n  ${key}: ${JSON.stringify(
          api.apiCode,
        )},`,
    ),
    "} as const;",
    "",
    "export type YiqichaApiKey = keyof typeof yiqichaApiCodes;",
    "",
  ].join("\n");
}

export function generateTypes(apis) {
  const entries = getApiEntries(apis);
  const lines = [
    "// Generated from data/apis.json. Run `pnpm --filter @repo/yiqicha generate-types` after updating the catalog.",
    'import { type YiqichaApiKey } from "./api-codes.ts";',
    "",
  ];

  for (const { api, typeName } of entries) {
    const params = parseFieldList(api.requestJson);
    const response = parseFieldList(api.responseJson);
    const responseDemo = parseJson(api.responseDemo);

    lines.push(`/** ${escapeComment(api.apiName)} request parameters. */`);
    lines.push(`export interface ${typeName}Params {`);
    if (params.length === 0) {
      lines.push("  [key: string]: never;");
    } else {
      lines.push(...renderProperties(params, responseDemo, "request"));
    }
    lines.push("}");
    lines.push("");
    lines.push(`/** ${escapeComment(api.apiName)} response. */`);
    lines.push(`export interface ${typeName}Response ${renderObject(response, responseDemo, 0)}`);
    lines.push("");
  }

  lines.push("export interface YiqichaApiTypeMap {");
  for (const { key, typeName } of entries) {
    lines.push(`  ${key}: {`);
    lines.push(`    params: ${typeName}Params;`);
    lines.push(`    response: ${typeName}Response;`);
    lines.push("  };");
  }
  lines.push("}");
  lines.push("");
  lines.push(
    'export type YiqichaApiParamsByKey<Key extends YiqichaApiKey> = YiqichaApiTypeMap[Key]["params"];',
  );
  lines.push(
    'export type YiqichaApiResponseByKey<Key extends YiqichaApiKey> = YiqichaApiTypeMap[Key]["response"];',
  );
  lines.push("");

  return lines.join("\n");
}

function parseFieldList(value) {
  if (!value) return [];

  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function renderObject(fields, sample, depth) {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);

  if (fields.length === 0) return "{\n" + `${childIndent}[key: string]: unknown;\n${indent}}`;

  return `{\n${renderProperties(fields, sample, "response", depth + 1).join("\n")}\n${indent}}`;
}

function renderProperties(fields, sample, mode, depth = 1) {
  return groupFields(fields).flatMap((group) => renderPropertyGroup(group, sample, mode, depth));
}

function renderPropertyGroup(group, sample, mode, depth = 1) {
  const [field] = group;
  const fieldSample = getSample(sample, field.name);
  const required = mode === "request" ? group.some(isRequired) : fieldSample !== undefined;
  const optional = required ? "" : "?";
  const desc = group
    .map((item) => (typeof item.desc === "string" ? item.desc : ""))
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index)
    .join(" / ");
  const type = unique(group.map((item) => renderType(item, fieldSample))).join(" | ");
  const property = `${renderPropertyName(field.name)}${optional}: ${type};`;
  const lines = [];
  const indent = "  ".repeat(depth);

  if (desc) lines.push(`${indent}/** ${escapeComment(desc)} */`);
  lines.push(`${indent}${property}`);

  return lines;
}

function groupFields(fields) {
  const groups = [];
  const groupByName = new Map();

  for (const field of fields) {
    const key = String(field.name);
    const existing = groupByName.get(key);

    if (existing) {
      existing.push(field);
      continue;
    }

    const group = [field];
    groupByName.set(key, group);
    groups.push(group);
  }

  return groups;
}

function renderType(field, sample) {
  const docType = normalizeType(field.type);
  const dataFields = Array.isArray(field.data) ? field.data : [];
  const listFields = Array.isArray(field.list) ? field.list : [];
  let type;

  if (dataFields.length > 0 && !Array.isArray(sample)) {
    type = renderObject(dataFields, sample, 0);
  } else if (listFields.length > 0 || docType === "array" || Array.isArray(sample)) {
    const itemFields = listFields.length > 0 ? listFields : dataFields;
    const sampleItem = Array.isArray(sample) ? sample.find((item) => item != null) : undefined;
    const itemType =
      itemFields.length > 0
        ? renderObject(itemFields, sampleItem, 0)
        : inferTypeFromSample(sampleItem);
    type = `Array<${itemType}>`;
  } else if (docType === "object") {
    const fields = dataFields.length > 0 ? dataFields : listFields;
    type = renderObject(fields, sample, 0);
  } else if (docType === "number") {
    type = "number";
  } else if (docType === "boolean") {
    type = "boolean";
  } else if (docType === "string") {
    type = "string";
  } else {
    type = inferTypeFromSample(sample);
  }

  const sampleType = inferPrimitiveTypeFromSample(sample);
  if (sampleType && isPrimitiveType(type) && sampleType !== type) {
    type = unique([type, sampleType]).join(" | ");
  }

  if (sample === null && !type.includes("null")) return `${type} | null`;

  return type;
}

function inferTypeFromSample(sample) {
  if (sample === null) return "unknown | null";
  if (sample === undefined) return "unknown";
  if (Array.isArray(sample)) {
    const item = sample.find((value) => value != null);
    return `Array<${inferTypeFromSample(item)}>`;
  }
  if (typeof sample === "object") return "Record<string, unknown>";
  if (typeof sample === "number") return "number";
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "string") return "string";
  return "unknown";
}

function inferPrimitiveTypeFromSample(sample) {
  if (typeof sample === "number") return "number";
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "string") return "string";

  return undefined;
}

function isPrimitiveType(type) {
  return type === "string" || type === "number" || type === "boolean";
}

function normalizeType(type) {
  const normalized = String(type ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");

  if (normalized === "array" || normalized === "list" || normalized.includes("list<")) {
    return "array";
  }
  if (normalized === "object" || normalized.includes("object")) return "object";
  if (
    normalized === "int" ||
    normalized === "int32" ||
    normalized === "int64" ||
    normalized === "integer" ||
    normalized === "long" ||
    normalized === "double" ||
    normalized === "float" ||
    normalized === "number" ||
    normalized === "bigdecimal"
  ) {
    return "number";
  }
  if (normalized === "boolean" || normalized === "bool") return "boolean";
  if (normalized === "string" || normalized === "date") return "string";

  return "unknown";
}

function getSample(sample, name) {
  if (sample && typeof sample === "object" && !Array.isArray(sample) && name in sample) {
    return sample[name];
  }

  return undefined;
}

function isRequired(field) {
  return field.required === true || field.required === "true";
}

function renderPropertyName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function unique(values) {
  return values.filter((value, index, array) => array.indexOf(value) === index);
}

function toPascalCase(value) {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = words.map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join("");

  return /^[0-9]/.test(name) ? `Api${name}` : name;
}

function escapeComment(value) {
  return String(value).replaceAll("*/", "* /");
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const data = JSON.parse(await readFile(dataUrl, "utf8"));
  await writeGeneratedSources(data.apis);
  console.log(`generated ${data.apis.length} API type entries`);
}
