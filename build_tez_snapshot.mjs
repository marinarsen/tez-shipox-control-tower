import fs from "node:fs";
import path from "node:path";

const sourceCsv = process.env.TEZ_SOURCE_CSV || path.join(process.cwd(), "shipox_order_export_prod_api_fast.csv");
const sourceResult = process.env.TEZ_SOURCE_RESULT || path.join(process.cwd(), "shipox_order_export_prod_api_fast_result.json");
const outFile = process.env.TEZ_SNAPSHOT_OUT || path.join(process.cwd(), "snapshot.js");

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
  "Out of delivery area",
  "Delivery attempt",
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
  const normalized = raw.replace(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/, "$1 $2 $3");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function iso(date) {
  return date ? date.toISOString().slice(0, 10) : "";
}

function dayDiff(from, to) {
  if (!from || !to) return null;
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.max(0, Math.round((b - a) / 86400000));
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

function readSourceResult() {
  if (!fs.existsSync(sourceResult)) return {};
  try {
    return JSON.parse(fs.readFileSync(sourceResult, "utf8"));
  } catch {
    return {};
  }
}

if (!fs.existsSync(sourceCsv)) {
  throw new Error(`Source CSV not found: ${sourceCsv}`);
}

const rows = parseCsv(fs.readFileSync(sourceCsv, "utf8"));
const headers = rows.shift() || [];
const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
for (const required of [
  "Номер заказа",
  "Текущий статус",
  "Дата создания",
  "Дата последнего обновления статуса",
  "Название склада",
]) {
  if (!(required in idx)) throw new Error(`Missing CSV column: ${required}`);
}

const exportedAt = new Date();
const sourceExport = readSourceResult();
const orders = [];
const warehouseSet = new Set();
let minDate = "";
let maxDate = "";

for (const row of rows) {
  const createdAt = parseDate(row[idx["Дата создания"]]);
  if (!createdAt) continue;
  const updatedAt = parseDate(row[idx["Дата последнего обновления статуса"]]);
  const firstAttemptAt = parseDate(row[idx["Первая попытка доставки"]]);
  const status = row[idx["Текущий статус"]] || "Unknown";
  const rawWarehouse = row[idx["Название склада"]] || row[idx["Название склада отправления"]];
  const warehouse = normalizeWarehouse(rawWarehouse);
  const isFinal = FINAL_STATUSES.has(status);
  const isDelivered = status === "Order Completed";
  const isReturned = status === "Returned to origin";
  const isCancelled = status === "Order Cancelled";
  const isClientIssue = CLIENT_ISSUE_STATUSES.has(status);
  const createdDate = iso(createdAt);
  const updatedDate = iso(updatedAt);
  const firstAttemptDate = iso(firstAttemptAt);
  const ageDays = dayDiff(createdAt, exportedAt);

  if (!minDate || createdDate < minDate) minDate = createdDate;
  if (!maxDate || createdDate > maxDate) maxDate = createdDate;
  warehouseSet.add(warehouse);

  orders.push({
    id: maskOrderId(row[idx["Номер заказа"]]),
    status,
    bucket: statusBucket(status),
    warehouse,
    createdDate,
    updatedDate,
    firstAttemptDate,
    ageDays,
    dtDays: isDelivered ? dayDiff(createdAt, updatedAt) : null,
    firstAttemptDays: firstAttemptAt ? dayDiff(createdAt, firstAttemptAt) : null,
    isFinal,
    isDelivered,
    isReturned,
    isCancelled,
    isClientIssue,
  });
}

const warehouseRank = new Map(WAREHOUSE_ORDER.map((w, i) => [w, i]));
const warehouses = [...warehouseSet].sort((a, b) => {
  const ai = warehouseRank.get(a) ?? 999;
  const bi = warehouseRank.get(b) ?? 999;
  return ai - bi || a.localeCompare(b);
});

const snapshot = {
  generatedAt: exportedAt.toISOString(),
  sourceCsv: path.basename(sourceCsv),
  sourceExport,
  availableRange: { from: minDate, to: maxDate },
  warehouses,
  orders: orders.sort((a, b) => b.createdDate.localeCompare(a.createdDate)),
};

fs.writeFileSync(outFile, `window.TEZ_SNAPSHOT = ${JSON.stringify(snapshot)};\n`, "utf8");
console.log(`Wrote ${outFile} from ${orders.length} orders (${minDate}..${maxDate})`);
