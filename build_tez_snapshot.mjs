import fs from "node:fs";
import path from "node:path";

const sourceRoot = "C:/Users/HP/Documents/Codex/workspace/tezbank-dashboard";
const sourceCsv = path.join(sourceRoot, "shipox_order_export_prod_api_fast.csv");
const sourceResult = path.join(sourceRoot, "shipox_order_export_prod_api_fast_result.json");
const outFile = path.join(process.cwd(), "snapshot.js");

const FINAL_STATUSES = new Set(["Order Completed", "Order Cancelled", "Returned to origin"]);
const CLIENT_ISSUE_STATUSES = new Set([
  "Bad recipient address",
  "Recipient address change requested",
  "Recipient mobile no response",
  "Recipient mobile switched off",
  "Recipient mobile wrong",
  "Recipient not available",
  "Future delivery requested",
  "Unable to access recipient premises",
  "Delivery rejected",
  "cancelled_due_to_out_of_delivery_area",
  "delivery_attempt",
]);

const WAREHOUSE_ORDER = [
  "TOSHKENT",
  "NUKUS",
  "URGANCH",
  "BUXORO",
  "G'IJDUVON",
  "NAVOIY",
  "ZARAFSHON",
  "SAMARQAND",
  "QARSHI",
  "SHAHRISABZ",
  "TERMIZ",
  "DENOV",
  "JIZZAX",
  "GULISTON",
  "CHIRCHIQ",
  "ANGREN",
  "NAMANGAN",
  "ANDIJON",
  "FARG'ONA",
  "QO'QON",
  "KATTAQ'ORGO'N",
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (quoted) {
      if (c === '"' && n === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") {
      cell += c;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim()));
}

function parseDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const d = new Date(raw.replace(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/, "$1 $2 $3"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateKey(date) {
  return date ? date.toISOString().slice(0, 10) : "";
}

function dayDiff(from, to) {
  if (!from || !to) return null;
  return Math.max(0, Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86400000));
}

function normalizeWarehouse(value) {
  const s = String(value || "").toUpperCase().replace(/\s+/g, " ").trim();
  const withoutId = s.replace(/^\d+\s+/, "").replace(/\s+WAREHOUSE$/, "").trim();
  if (!withoutId) return "UNKNOWN";
  if (withoutId.includes("TASHKENT") || withoutId.includes("TOSHKENT")) return "TOSHKENT";
  if (withoutId.includes("KOKAND") || withoutId.includes("QO'QON")) return "QO'QON";
  if (withoutId.includes("KATTA")) return "KATTAQ'ORGO'N";
  return withoutId;
}

function statusBucket(status) {
  if (status === "Order Completed") return "delivered";
  if (status === "Returned to origin") return "returned";
  if (status === "Order Cancelled") return "cancelled";
  if (CLIENT_ISSUE_STATUSES.has(status)) return "clientIssue";
  if (status.toLowerCase().includes("failed")) return "failed";
  return "activeOps";
}

function maskOrderId(value) {
  const id = String(value || "");
  if (id.length <= 3) return "***";
  return `${id.slice(0, Math.max(3, id.length - 3))}***`;
}

function emptyWarehouse(name) {
  return {
    warehouse: name,
    total: 0,
    active: 0,
    delivered: 0,
    returned: 0,
    cancelled: 0,
    clientIssue: 0,
    failed: 0,
    over3d: 0,
    over7d: 0,
    noFirstAttempt3d: 0,
    dtSum: 0,
    dtCount: 0,
    faSum: 0,
    faCount: 0,
    created7d: 0,
    delivered7d: 0,
    statuses: {},
  };
}

function add(map, key, patch = {}) {
  if (!map.has(key)) map.set(key, { key, ...patch });
  return map.get(key);
}

const rows = parseCsv(fs.readFileSync(sourceCsv, "utf8"));
const headers = rows.shift();
const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
const exportResult = fs.existsSync(sourceResult) ? JSON.parse(fs.readFileSync(sourceResult, "utf8")) : {};
const now = new Date();
const orders = [];
const warehouses = new Map();
const daily = new Map();
const statuses = new Map();

for (const row of rows) {
  const id = row[idx["Номер заказа"]];
  const status = row[idx["Текущий статус"]] || "Unknown";
  const createdAt = parseDate(row[idx["Дата создания"]]);
  const updatedAt = parseDate(row[idx["Дата последнего обновления статуса"]]);
  const firstAttemptAt = parseDate(row[idx["Первая попытка доставки"]]);
  const rawWarehouse = row[idx["Название склада"]] || row[idx["Название склада отправления"]];
  const warehouse = normalizeWarehouse(rawWarehouse);
  const isFinal = FINAL_STATUSES.has(status);
  const isDelivered = status === "Order Completed";
  const isReturned = status === "Returned to origin";
  const isCancelled = status === "Order Cancelled";
  const isClientIssue = CLIENT_ISSUE_STATUSES.has(status);
  const ageDays = dayDiff(createdAt, now);
  const dtDays = isDelivered ? dayDiff(createdAt, updatedAt) : null;
  const firstAttemptDays = firstAttemptAt ? dayDiff(createdAt, firstAttemptAt) : null;
  const bucket = statusBucket(status);

  const order = {
    id: maskOrderId(id),
    status,
    bucket,
    warehouse,
    rawWarehouse,
    createdAt: createdAt?.toISOString() || "",
    updatedAt: updatedAt?.toISOString() || "",
    firstAttemptAt: firstAttemptAt?.toISOString() || "",
    ageDays,
    dtDays,
    firstAttemptDays,
    isFinal,
    isDelivered,
    isReturned,
    isCancelled,
    isClientIssue,
  };
  orders.push(order);

  const wh = warehouses.get(warehouse) || emptyWarehouse(warehouse);
  wh.total++;
  wh.active += isFinal ? 0 : 1;
  wh.delivered += isDelivered ? 1 : 0;
  wh.returned += isReturned ? 1 : 0;
  wh.cancelled += isCancelled ? 1 : 0;
  wh.clientIssue += isClientIssue && !isFinal ? 1 : 0;
  wh.failed += bucket === "failed" ? 1 : 0;
  wh.over3d += !isFinal && ageDays > 3 ? 1 : 0;
  wh.over7d += !isFinal && ageDays > 7 ? 1 : 0;
  wh.noFirstAttempt3d += !isFinal && !firstAttemptAt && ageDays > 3 ? 1 : 0;
  if (dtDays != null) {
    wh.dtSum += dtDays;
    wh.dtCount++;
  }
  if (firstAttemptDays != null) {
    wh.faSum += firstAttemptDays;
    wh.faCount++;
  }
  const createdKey = dateKey(createdAt);
  if (createdKey >= dateKey(new Date(now.getTime() - 7 * 86400000))) wh.created7d++;
  if (isDelivered && dateKey(updatedAt) >= dateKey(new Date(now.getTime() - 7 * 86400000))) wh.delivered7d++;
  wh.statuses[status] = (wh.statuses[status] || 0) + 1;
  warehouses.set(warehouse, wh);

  const statusRow = add(statuses, status, { status, bucket, count: 0, active: 0, avgAgeSum: 0 });
  statusRow.count++;
  if (!isFinal) {
    statusRow.active++;
    statusRow.avgAgeSum += ageDays || 0;
  }

  if (createdAt) {
    const d = add(daily, createdKey, { date: createdKey, created: 0, delivered: 0, returned: 0, cancelled: 0, activeDelta: 0 });
    d.created++;
    d.activeDelta++;
  }
  if (isDelivered || isReturned || isCancelled) {
    const d = add(daily, dateKey(updatedAt), { date: dateKey(updatedAt), created: 0, delivered: 0, returned: 0, cancelled: 0, activeDelta: 0 });
    if (isDelivered) d.delivered++;
    if (isReturned) d.returned++;
    if (isCancelled) d.cancelled++;
    d.activeDelta--;
  }
}

const warehouseRank = new Map(WAREHOUSE_ORDER.map((w, i) => [w, i]));
const warehouseRows = [...warehouses.values()]
  .map((w) => ({
    ...w,
    avgDt: w.dtCount ? w.dtSum / w.dtCount : 0,
    avgFirstAttempt: w.faCount ? w.faSum / w.faCount : 0,
    risk: w.noFirstAttempt3d > 80 || w.over7d > 80 ? "critical" : w.noFirstAttempt3d > 25 || w.over3d > 120 ? "risk" : w.active > 200 || w.clientIssue > 20 ? "watch" : "ok",
  }))
  .sort((a, b) => (warehouseRank.get(a.warehouse) ?? 999) - (warehouseRank.get(b.warehouse) ?? 999) || b.total - a.total);

const dailyRows = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
let runningActive = 0;
for (const d of dailyRows) {
  runningActive += d.activeDelta;
  d.activeEod = runningActive;
}

const delivered = orders.filter((o) => o.isDelivered);
const active = orders.filter((o) => !o.isFinal);
const returned = orders.filter((o) => o.isReturned);
const cancelled = orders.filter((o) => o.isCancelled);
const avg = (arr, fn) => (arr.length ? arr.reduce((s, x) => s + (fn(x) || 0), 0) / arr.length : 0);
const within3 = delivered.filter((o) => o.dtDays != null && o.dtDays <= 3).length;

const snapshot = {
  generatedAt: new Date().toISOString(),
  sourceCsv: path.basename(sourceCsv),
  sourceExport: exportResult,
  kpis: {
    total: orders.length,
    active: active.length,
    delivered: delivered.length,
    returned: returned.length,
    cancelled: cancelled.length,
    clientIssue: active.filter((o) => o.isClientIssue).length,
    over3d: active.filter((o) => o.ageDays > 3).length,
    over7d: active.filter((o) => o.ageDays > 7).length,
    noFirstAttempt3d: active.filter((o) => !o.firstAttemptAt && o.ageDays > 3).length,
    avgDt: avg(delivered, (o) => o.dtDays),
    avgFirstAttempt: avg(orders.filter((o) => o.firstAttemptDays != null), (o) => o.firstAttemptDays),
    within3Pct: delivered.length ? (within3 / delivered.length) * 100 : 0,
  },
  warehouses: warehouseRows,
  statuses: [...statuses.values()]
    .map((s) => ({ ...s, avgActiveAge: s.active ? s.avgAgeSum / s.active : 0 }))
    .sort((a, b) => b.count - a.count),
  daily: dailyRows,
  orders: orders
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, 500),
  tails: active
    .filter((o) => o.ageDays > 7)
    .sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0))
    .slice(0, 120),
};

fs.writeFileSync(outFile, `window.TEZ_SNAPSHOT = ${JSON.stringify(snapshot, null, 2)};\n`, "utf8");
console.log(`Wrote ${outFile} from ${orders.length} orders`);
