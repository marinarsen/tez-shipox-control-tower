import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(".");
const LEGACY_ORDER_FETCH = path.join(ROOT, "order_fetch.js");

const AUTH_URL = process.env["SHIPOX_AUTH_URL"] || "https://gateway.fargo.uz/api/v1/authenticate";
const ORDERS_URL = process.env["SHIPOX_ORDERS_URL"] || "https://gateway.fargo.uz/api/v2/admin/orders";
const CSV_HEADERS = [
  "Номер заказа",
  "Текущий статус",
  "Дата создания",
  "Дата последнего обновления статуса",
  "Первая попытка доставки",
  "Название склада",
  "Название склада отправления",
];

const STATUS_MAP = new Map([
  ["accepted", "Accept"],
  ["assigned_to_courier", "Assigned to courier"],
  ["arrived_to_delivery_address", "Arrived to Delivery address"],
  ["bad_weather_during_delivery", "Bad weather during delivery"],
  ["bad_recipient_address", "Bad recipient address"],
  ["cancelled", "Order Cancelled"],
  ["cancelled_due_to_out_of_delivery_area", "Out of delivery area"],
  ["cod_not_ready", "COD not ready"],
  ["collection_arranged_or_requested", "Collection arranged or requested"],
  ["completed", "Order Completed"],
  ["delivery_attempt", "Delivery attempt"],
  ["delivery_failed", "Delivery failed"],
  ["delivery_rejected", "Delivery rejected"],
  ["dispatched", "Dispatched"],
  ["future_delivery_requested", "Future delivery requested"],
  ["id_or_document_required_missing", "ID or document required missing"],
  ["in_sorting_facility", "In sorting facility"],
  ["in_transit", "In Transit"],
  ["out_for_delivery", "Out for delivery"],
  ["out_of_delivery_area", "Out of delivery area"],
  ["recipient_address_change_requested", "Recipient address change requested"],
  ["recipient_mobile_no_response", "Recipient mobile no response"],
  ["recipient_mobile_switched_off", "Recipient mobile switched off"],
  ["recipient_mobile_wrong", "Recipient mobile wrong"],
  ["recipient_not_available", "Recipient not available"],
  ["recipient_wants_inspect_item", "Recipient wants inspect item"],
  ["returned_to_origin", "Returned to origin"],
  ["unassigned", "Order Received"],
  ["wrong_shipment", "Wrong shipment"],
]);

function parseArgs(argv) {
  const out = {
    customerId: process.env["SHIPOX_CUSTOMER_ID"] || "",
    fromDateTime: "2026-01-01 00:00",
    pageSize: 200,
    concurrency: Number(process.env["SHIPOX_CONCURRENCY"]) || 6,
    headRefreshPages: Number(process.env["SHIPOX_HEAD_REFRESH_PAGES"]) || 3,
    requestTimeoutMs: Number(process.env["SHIPOX_REQUEST_TIMEOUT_MS"]) || 45000,
    limitPages: 0,
    outCsv: "shipox_order_export.csv",
    outJson: "shipox_order_export_result.json",
    resumeCache: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--customer-id") out.customerId = String(argv[++i] || "");
    else if (arg.startsWith("--customer-id=")) out.customerId = arg.slice("--customer-id=".length);
    else if (arg === "--from") out.fromDateTime = String(argv[++i] || out.fromDateTime);
    else if (arg.startsWith("--from=")) out.fromDateTime = arg.slice("--from=".length);
    else if (arg === "--page-size") out.pageSize = Number(argv[++i]) || out.pageSize;
    else if (arg.startsWith("--page-size=")) out.pageSize = Number(arg.slice("--page-size=".length)) || out.pageSize;
    else if (arg === "--concurrency") out.concurrency = Number(argv[++i]) || out.concurrency;
    else if (arg.startsWith("--concurrency=")) out.concurrency = Number(arg.slice("--concurrency=".length)) || out.concurrency;
    else if (arg === "--head-refresh-pages") out.headRefreshPages = Number(argv[++i]) || out.headRefreshPages;
    else if (arg.startsWith("--head-refresh-pages=")) out.headRefreshPages = Number(arg.slice("--head-refresh-pages=".length)) || out.headRefreshPages;
    else if (arg === "--request-timeout-ms") out.requestTimeoutMs = Number(argv[++i]) || out.requestTimeoutMs;
    else if (arg.startsWith("--request-timeout-ms=")) out.requestTimeoutMs = Number(arg.slice("--request-timeout-ms=".length)) || out.requestTimeoutMs;
    else if (arg === "--limit-pages") out.limitPages = Number(argv[++i]) || 0;
    else if (arg.startsWith("--limit-pages=")) out.limitPages = Number(arg.slice("--limit-pages=".length)) || 0;
    else if (arg === "--out") out.outCsv = String(argv[++i] || out.outCsv);
    else if (arg.startsWith("--out=")) out.outCsv = arg.slice("--out=".length);
    else if (arg === "--result-file") out.outJson = String(argv[++i] || out.outJson);
    else if (arg.startsWith("--result-file=")) out.outJson = arg.slice("--result-file=".length);
    else if (arg === "--resume-cache") out.resumeCache = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  out.pageSize = Math.min(Math.max(out.pageSize, 1), 200);
  out.concurrency = Math.min(Math.max(out.concurrency, 1), 12);
  out.headRefreshPages = Math.min(Math.max(out.headRefreshPages, 0), 20);
  out.requestTimeoutMs = Math.min(Math.max(out.requestTimeoutMs, 5000), 120000);
  return out;
}

function printHelp() {
  console.log(`
Usage:
  node tools/shipox_export_orders.mjs --customer-id <id>
  node tools/shipox_export_orders.mjs --customer-id <id> --out api_order_export.csv
  node tools/shipox_export_orders.mjs --customer-id <id> --limit-pages 2
  node tools/shipox_export_orders.mjs --customer-id <id> --concurrency 6
  node tools/shipox_export_orders.mjs --customer-id <id> --head-refresh-pages 3
  node tools/shipox_export_orders.mjs --customer-id <id> --request-timeout-ms 45000
  node tools/shipox_export_orders.mjs --customer-id <id> --resume-cache

Cache:
  Normal runs delete the matching *.pages.jsonl first and start a fresh export.
  Only --resume-cache reuses a previous page cache.
  Normal full runs re-fetch the first few pages at the end to catch orders
  created while the long export was running.

Credentials:
  Preferred: set SHIPOX_USERNAME and SHIPOX_PASSWORD.
  Optional: set SHIPOX_ID_TOKEN to skip authentication.
  Legacy fallback: reads CONFIG.USERNAME/PASSWORD from order_fetch.js if env vars are absent.
`);
}

async function readLegacyConfig() {
  try {
    const text = await fs.readFile(LEGACY_ORDER_FETCH, "utf8");
    const username = text.match(/USERNAME:\s*"([^"]+)"/)?.[1] || "";
    const password = text.match(/PASSWORD:\s*"([^"]+)"/)?.[1] || "";
    return { username, password };
  } catch {
    return { username: "", password: "" };
  }
}

async function requestJson(url, options = {}) {
  const attempts = options.attempts || 5;
  const timeoutMs = options.timeoutMs || 45000;
  const cleanOptions = { ...options };
  delete cleanOptions.attempts;
  delete cleanOptions.timeoutMs;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...cleanOptions, signal: controller.signal });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 300)}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(json).slice(0, 500)}`);
      }
      return json;
    } catch (err) {
      lastError = err?.name === "AbortError"
        ? new Error(`Request timed out after ${timeoutMs} ms: ${url}`)
        : err;
      if (attempt === attempts) break;
      const waitMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
      console.log(`Request failed, retry ${attempt}/${attempts - 1} in ${waitMs} ms: ${lastError?.message || lastError}`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function getAuth() {
  if (process.env["SHIPOX_ID_TOKEN"]) {
    return {
      idToken: process.env["SHIPOX_ID_TOKEN"],
      marketplaceId: process.env["SHIPOX_MARKETPLACE_ID"] || "",
      source: "env SHIPOX_ID_TOKEN",
    };
  }
  const legacy = await readLegacyConfig();
  const username = process.env["SHIPOX_USERNAME"] || legacy.username;
  const password = process.env["SHIPOX_PASSWORD"] || legacy.password;
  if (!username || !password) {
    throw new Error("Missing Shipox credentials. Set SHIPOX_USERNAME/SHIPOX_PASSWORD or SHIPOX_ID_TOKEN.");
  }
  const json = await requestJson(AUTH_URL, {
    timeoutMs: Math.min(Number(process.env["SHIPOX_AUTH_TIMEOUT_MS"]) || 30000, 120000),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, remember_me: true }),
  });
  const idToken = json?.data?.id_token;
  if (!idToken) throw new Error("Authentication response did not contain data.id_token");
  return {
    idToken,
    marketplaceId: json?.data?.user?.marketplace_id || process.env["SHIPOX_MARKETPLACE_ID"] || "",
    source: process.env["SHIPOX_USERNAME"] ? "env username/password" : "legacy order_fetch.js",
  };
}

function formatShipoxDate(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env["SHIPOX_OUTPUT_TIME_ZONE"] || "Asia/Tashkent",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(dt).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.day}-${months.indexOf(parts.month) >= 0 ? parts.month : parts.month.slice(0, 3)}-${parts.year} ${pad(parts.hour)}:${parts.minute}:${parts.second}`;
}

function displayStatus(status) {
  if (!status) return "";
  return STATUS_MAP.get(status) || String(status).replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function collectWarehouseNames(orders) {
  const idToName = new Map();
  for (const order of orders) {
    for (const wh of [order.pick_up_warehouse, order.destination_warehouse, order.active_operation_warehouse]) {
      if (wh?.id && wh?.name) idToName.set(wh.id, wh.name);
    }
  }
  return idToName;
}

function orderToCsvRow(order, idToName) {
  const activeId = order.active_operation_warehouse?.id || order.active_operation_warehouse_id || "";
  const currentWarehouse = activeId ? (idToName.get(activeId) || "") : "";
  const sourceWarehouse = order.pick_up_warehouse?.name || "";
  return [
    order.order_number || "",
    displayStatus(order.status),
    formatShipoxDate(order.created_date),
    formatShipoxDate(order.last_status_date),
    "",
    currentWarehouse,
    sourceWarehouse,
  ];
}

async function fetchOrders(options, auth) {
  const cachePath = path.resolve(ROOT, `${options.outCsv}.pages.jsonl`);
  const orders = [];
  let total = 0;
  let page = 0;
  const statusCounts = new Map();
  const unknownStatuses = new Set();

  const addOrders = (list) => {
    for (const order of list) {
      orders.push(order);
      const status = order.status || "";
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
      if (status && !STATUS_MAP.has(status)) unknownStatuses.add(status);
    }
  };

  const fetchPage = async (pageNumber) => {
    const params = new URLSearchParams({
      size: String(options.pageSize),
      page: String(pageNumber),
      simple: "false",
      from_date_time: options.fromDateTime,
    });
    if (options.customerId) params.set("customer_id", options.customerId);
    const json = await requestJson(`${ORDERS_URL}?${params}`, {
      attempts: 6,
      timeoutMs: options.requestTimeoutMs,
      headers: {
        Authorization: `Bearer ${auth.idToken}`,
        Accept: "application/json",
        marketplace_id: String(auth.marketplaceId || ""),
      },
    });
    return {
      page: pageNumber,
      total: Number(json?.data?.total || 0),
      list: json?.data?.list || [],
    };
  };

  const appendFetchedPage = async (fetchedPage) => {
    const list = fetchedPage.list || [];
    total = Number(fetchedPage.total || total || 0);
    await fs.appendFile(cachePath, JSON.stringify({ page: fetchedPage.page, total, list }) + "\n", "utf8");
    addOrders(list);
    const fetched = orders.length;
    const pct = total ? Math.round((fetched / total) * 100) : "?";
    console.log(`Page ${fetchedPage.page}: ${list.length} orders, fetched ${fetched}/${total || "?"} (${pct}%)`);
    return list.length;
  };

  if (options.resumeCache) {
    try {
      const cachedText = await fs.readFile(cachePath, "utf8");
      for (const line of cachedText.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const cached = JSON.parse(line);
        if (cached.page !== page) break;
        const cachedList = cached.list || [];
        total = Number(cached.total || total || 0);
        addOrders(cachedList);
        page++;
      }
      if (page > 0) {
        console.log(`Resuming from page ${page}; loaded ${orders.length} cached orders from ${cachePath}`);
      }
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  } else {
    try {
      await fs.unlink(cachePath);
      console.log(`Starting fresh export; deleted old page cache ${cachePath}`);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  if (total && orders.length >= total) {
    return { orders, total, pagesFetched: page, statusCounts, unknownStatuses };
  }

  console.log(`API fetch concurrency: ${options.concurrency}`);

  while (true) {
    if (total && orders.length >= total) break;
    if (options.limitPages && page >= options.limitPages) break;

    if (!total || options.concurrency === 1) {
      const fetchedPage = await fetchPage(page);
      const rowCount = await appendFetchedPage(fetchedPage);
      page++;
      if (!rowCount) break;
      continue;
    }

    const totalPages = Math.ceil(total / options.pageSize);
    const targetPages = options.limitPages ? Math.min(totalPages, options.limitPages) : totalPages;
    const pages = [];
    for (let p = page; p < targetPages && pages.length < options.concurrency; p++) {
      pages.push(p);
    }
    if (!pages.length) break;

    const fetchedPages = await Promise.all(pages.map((p) => fetchPage(p)));
    fetchedPages.sort((a, b) => a.page - b.page);
    let shouldStop = false;
    for (const fetchedPage of fetchedPages) {
      const rowCount = await appendFetchedPage(fetchedPage);
      page = fetchedPage.page + 1;
      if (!rowCount) {
        shouldStop = true;
        break;
      }
    }
    if (shouldStop) break;
  }
  if (!options.limitPages && options.headRefreshPages > 0) {
    const pagesToRefresh = total
      ? Math.min(options.headRefreshPages, Math.ceil(total / options.pageSize))
      : options.headRefreshPages;
    console.log(`Refreshing first ${pagesToRefresh} page(s) to catch orders created during the export`);
    const refreshedPages = await Promise.all(
      Array.from({ length: pagesToRefresh }, (_, p) => fetchPage(p))
    );
    refreshedPages.sort((a, b) => a.page - b.page);
    for (const fetchedPage of refreshedPages) {
      const refreshed = { ...fetchedPage, page: `refresh-${fetchedPage.page}` };
      await appendFetchedPage(refreshed);
    }
  }
  return { orders, total, pagesFetched: page, statusCounts, unknownStatuses };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const auth = await getAuth();
  console.log(`Shipox auth OK via ${auth.source}; marketplace_id=${auth.marketplaceId || "(not set)"}`);
  if (!options.customerId) {
    console.log("Warning: no --customer-id was provided. The export may include all accessible Fargo orders.");
  }
  const fetched = await fetchOrders(options, auth);
  const idToName = collectWarehouseNames(fetched.orders);
  const rows = fetched.orders.map((order) => orderToCsvRow(order, idToName));
  const csv = [CSV_HEADERS, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
  const outCsvPath = path.resolve(ROOT, options.outCsv);
  await fs.writeFile(outCsvPath, csv, "utf8");

  const result = {
    ts: new Date().toISOString(),
    source: "shipox_api",
    authSource: auth.source,
    customerId: options.customerId || null,
    fromDateTime: options.fromDateTime,
    pageSize: options.pageSize,
    concurrency: options.concurrency,
    headRefreshPages: options.headRefreshPages,
    requestTimeoutMs: options.requestTimeoutMs,
    resumeCache: options.resumeCache,
    pagesFetched: fetched.pagesFetched,
    totalReported: fetched.total,
    rowsWritten: rows.length,
    outputCsv: outCsvPath,
    pageCache: path.resolve(ROOT, `${options.outCsv}.pages.jsonl`),
    knownWarehouseIds: idToName.size,
    unknownStatuses: Array.from(fetched.unknownStatuses).sort(),
    statusCounts: Object.fromEntries(Array.from(fetched.statusCounts.entries()).sort((a, b) => b[1] - a[1])),
    firstAttemptDate: {
      available: false,
      note: "The tested admin/orders list response exposes delivery_attempt_count but not the timestamp of the first attempt.",
    },
  };
  const outJsonPath = path.resolve(ROOT, options.outJson);
  await fs.writeFile(outJsonPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`Wrote ${rows.length} rows to ${outCsvPath}`);
  console.log(`Wrote report to ${outJsonPath}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
