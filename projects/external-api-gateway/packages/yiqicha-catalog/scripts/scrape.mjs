import { writeFile } from "node:fs/promises";

import { writeGeneratedSources } from "./generate-types.mjs";

const baseUrl = "https://openapi.yiqicha.com";
const source =
  "https://openapi.yiqicha.com/apiList/index?isApiDetail=2&cateName=%E6%89%80%E6%9C%89API&id=1813830945437331457";
const headers = { "content-type": "application/json;charset=UTF-8" };

async function post(path, body = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (json.status !== 1) {
    throw new Error(`${path} status ${json.status}: ${json.message}`);
  }

  return json.data;
}

const categories = await post("/gateway/order-server/interface/query/cate");
const list = await post("/gateway/client-server/platform/show/api/address/list", {
  keyword: "",
  page: 1,
  pageSize: 999,
});
const apis = [];

for (const [index, item] of list.list.entries()) {
  const detail = await post(`/gateway/order-server/interface/query/interface/detail/${item.id}`);
  let demo = null;

  try {
    demo = await post("/gateway/client-server/platform/show/api/interface/demo", {
      id: item.id,
    });
  } catch (error) {
    demo = { error: String(error) };
  }

  apis.push({ ...item, ...detail, demo });

  if ((index + 1) % 20 === 0 || index + 1 === list.list.length) {
    console.log(`fetched ${index + 1}/${list.list.length}`);
  }
}

apis.sort((left, right) =>
  String(left.apiCode).localeCompare(String(right.apiCode), "en", {
    numeric: true,
  }),
);

await writeFile(
  new URL("../data/apis.json", import.meta.url),
  `${JSON.stringify(
    {
      source,
      fetchedAt: new Date().toISOString(),
      totalCount: list.totalCount,
      categories,
      apis,
    },
    null,
    2,
  )}\n`,
);
await writeGeneratedSources(apis);

console.log(`wrote ${apis.length} APIs`);
