const snapshot = window.TEZ_SNAPSHOT;

const bucketLabels = {
  all: "Все статусы",
  activeOps: "В работе",
  clientIssue: "Клиентское уточнение",
  failed: "Failed",
  delivered: "Доставлено",
  returned: "Возврат",
  cancelled: "Отмена",
};

const colors = ["#127a5a", "#226fb2", "#d8a21e", "#d66a2f", "#cf3f3f", "#6c5aa8"];
const UPDATE_WORKFLOW_URL = "https://github.com/marinarsen/tez-shipox-control-tower/actions/workflows/update-tez-dashboard.yml";
const fmt = new Intl.NumberFormat("ru-RU");
const fmt1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

const state = {
  warehouse: "all",
  status: "all",
  search: "",
  dateFrom: snapshot.availableRange?.from || "",
  dateTo: snapshot.availableRange?.to || "",
  selectedWarehouse: snapshot.warehouses?.[0] || "TOSHKENT",
};

function n(value) {
  return fmt.format(Math.round(Number(value) || 0));
}

function f1(value) {
  return fmt1.format(Number(value) || 0);
}

function pct(value) {
  return `${f1(value)}%`;
}

function days(value) {
  return value ? `${f1(value)} дн` : "0 дн";
}

function parseDay(value) {
  return new Date(`${value}T00:00:00`);
}

function iso(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value, daysCount) {
  const d = parseDay(value);
  d.setDate(d.getDate() + daysCount);
  return iso(d);
}

function rangeDays(from, to) {
  return Math.max(1, Math.round((parseDay(to) - parseDay(from)) / 86400000) + 1);
}

function rangeLabel(from, to) {
  if (!from || !to) return "нет периода";
  const format = (v) => v.split("-").reverse().join(".");
  return from === to ? format(from) : `${format(from)} - ${format(to)}`;
}

function previousRange(from, to) {
  const len = rangeDays(from, to);
  if (len === 1) return { from: addDays(from, -7), to: addDays(to, -7), label: "тот же день прошлой недели" };
  return { from: addDays(from, -len), to: addDays(from, -1), label: `предыдущие ${len} дн.` };
}

function inRange(date, from, to) {
  return date >= from && date <= to;
}

function applyBaseFilters(order) {
  const needle = state.search.trim().toLowerCase();
  if (state.warehouse !== "all" && order.warehouse !== state.warehouse) return false;
  if (state.status !== "all" && order.bucket !== state.status) return false;
  if (needle && !`${order.id} ${order.status} ${order.warehouse}`.toLowerCase().includes(needle)) return false;
  return true;
}

function ordersForRange(from, to) {
  return snapshot.orders.filter((order) => applyBaseFilters(order) && inRange(order.createdDate, from, to));
}

function summarize(orders) {
  const active = orders.filter((o) => !o.isFinal);
  const delivered = orders.filter((o) => o.isDelivered);
  const returned = orders.filter((o) => o.isReturned);
  const cancelled = orders.filter((o) => o.isCancelled);
  const withAttempt = orders.filter((o) => o.firstAttemptDays != null);
  const avg = (rows, fn) => rows.length ? rows.reduce((sum, item) => sum + (fn(item) || 0), 0) / rows.length : 0;
  const within3 = delivered.filter((o) => o.dtDays != null && o.dtDays <= 3).length;
  return {
    total: orders.length,
    active: active.length,
    delivered: delivered.length,
    returned: returned.length,
    cancelled: cancelled.length,
    clientIssue: active.filter((o) => o.isClientIssue).length,
    failed: orders.filter((o) => o.bucket === "failed").length,
    tails7: active.filter((o) => o.ageDays >= 7).length,
    noAttempt7: active.filter((o) => !o.firstAttemptDate && o.ageDays >= 7).length,
    avgDt: avg(delivered, (o) => o.dtDays),
    avgFirstAttempt: avg(withAttempt, (o) => o.firstAttemptDays),
    within3Pct: delivered.length ? (within3 / delivered.length) * 100 : 0,
    returnCancel: returned.length + cancelled.length,
  };
}

function deltaText(current, previous, kind = "number", lowerIsBetter = false) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  const diff = c - p;
  const sign = diff > 0 ? "+" : "";
  const formatted = kind === "days" ? `${sign}${f1(diff)} дн` : kind === "pct" ? `${sign}${f1(diff)} п.п.` : `${sign}${n(diff)}`;
  const tone = diff === 0 ? "flat" : (lowerIsBetter ? diff < 0 : diff > 0) ? "good" : "bad";
  return `<span class="delta ${tone}">${formatted}</span>`;
}

function metric(label, value, prevLine, tone = "") {
  return `<article class="metric ${tone}">
    <div class="metric-top"><span>${label}</span></div>
    <strong>${value}</strong>
    <small>${prevLine}</small>
  </article>`;
}

function kpis(current, previous) {
  return `<section class="kpis">
    ${metric("Заказы", n(current.total), `к прошлому: ${deltaText(current.total, previous.total)}`, "info")}
    ${metric("Активные", n(current.active), `к прошлому: ${deltaText(current.active, previous.active, "number", true)}`, current.active > previous.active ? "warn" : "")}
    ${metric("Доставлено", n(current.delivered), `к прошлому: ${deltaText(current.delivered, previous.delivered)}`)}
    ${metric("DT AVG", days(current.avgDt), `к прошлому: ${deltaText(current.avgDt, previous.avgDt, "days", true)}`, "info")}
    ${metric("До 1-й попытки", days(current.avgFirstAttempt), `к прошлому: ${deltaText(current.avgFirstAttempt, previous.avgFirstAttempt, "days", true)}`, "info")}
    ${metric("Хвосты 7+ дней", n(current.tails7), `к прошлому: ${deltaText(current.tails7, previous.tails7, "number", true)}`, current.tails7 ? "alert" : "")}
    ${metric("Без попытки 7+ дней", n(current.noAttempt7), `к прошлому: ${deltaText(current.noAttempt7, previous.noAttempt7, "number", true)}`, current.noAttempt7 ? "alert" : "")}
    ${metric("Возврат / отмена", n(current.returnCancel), `к прошлому: ${deltaText(current.returnCancel, previous.returnCancel, "number", true)}`, "warn")}
    ${metric("В 3 дня", pct(current.within3Pct), `к прошлому: ${deltaText(current.within3Pct, previous.within3Pct, "pct")}`)}
    ${metric("Client issue", n(current.clientIssue), `к прошлому: ${deltaText(current.clientIssue, previous.clientIssue, "number", true)}`, "warn")}
  </section>`;
}

function warehouseRows(currentOrders, previousOrders) {
  const previousByWarehouse = groupBy(previousOrders, (o) => o.warehouse);
  return snapshot.warehouses.map((warehouse) => {
    const rows = currentOrders.filter((o) => o.warehouse === warehouse);
    const prevRows = previousByWarehouse.get(warehouse) || [];
    const cur = summarize(rows);
    const prev = summarize(prevRows);
    return { warehouse, rows, cur, prev };
  }).filter((item) => item.rows.length || item.prev.total)
    .sort((a, b) => b.cur.total - a.cur.total || b.cur.active - a.cur.active);
}

function groupBy(rows, fn) {
  const map = new Map();
  for (const row of rows) {
    const key = fn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function warehouseTable(rows) {
  return `<article class="panel">
    <div class="section-head">
      <div><h2>Склады</h2><p>Все показатели пересчитываются по выбранным датам, ниже каждого значения показано сравнение с предыдущим периодом.</p></div>
    </div>
    <div class="table-shell"><table class="table">
      <thead><tr><th>Склад</th><th>Заказы</th><th>Активные</th><th>Доставлено</th><th>DT</th><th>1-я попытка</th><th>Хвосты 7+</th><th>Client issue</th><th>Возврат/отмена</th></tr></thead>
      <tbody>${rows.map((w) => `<tr data-wh="${w.warehouse}" class="${state.selectedWarehouse === w.warehouse ? "selected" : ""}">
        <td><strong>${w.warehouse}</strong></td>
        <td>${n(w.cur.total)}<small>${deltaText(w.cur.total, w.prev.total)}</small></td>
        <td>${n(w.cur.active)}<small>${deltaText(w.cur.active, w.prev.active, "number", true)}</small></td>
        <td>${n(w.cur.delivered)}<small>${deltaText(w.cur.delivered, w.prev.delivered)}</small></td>
        <td>${days(w.cur.avgDt)}<small>${deltaText(w.cur.avgDt, w.prev.avgDt, "days", true)}</small></td>
        <td>${days(w.cur.avgFirstAttempt)}<small>${deltaText(w.cur.avgFirstAttempt, w.prev.avgFirstAttempt, "days", true)}</small></td>
        <td>${n(w.cur.tails7)}<small>${deltaText(w.cur.tails7, w.prev.tails7, "number", true)}</small></td>
        <td>${n(w.cur.clientIssue)}<small>${deltaText(w.cur.clientIssue, w.prev.clientIssue, "number", true)}</small></td>
        <td>${n(w.cur.returnCancel)}<small>${deltaText(w.cur.returnCancel, w.prev.returnCancel, "number", true)}</small></td>
      </tr>`).join("")}</tbody>
    </table></div>
  </article>`;
}

function tailsPanel(rows) {
  const top = rows
    .map((w) => ({ ...w, tails: w.rows.filter((o) => !o.isFinal && o.ageDays >= 7) }))
    .filter((w) => w.tails.length)
    .sort((a, b) => b.tails.length - a.tails.length)
    .slice(0, 10);
  const max = Math.max(1, ...top.map((w) => w.tails.length));
  return `<article class="panel">
    <div class="section-head"><div><h2>Хвосты 7+ дней</h2><p>Только активные заказы, которым 7 или больше дней.</p></div></div>
    <div class="bars">${top.map((w) => `<button class="bar-card" data-wh="${w.warehouse}">
      <div class="row"><strong>${w.warehouse}</strong><span>${n(w.tails.length)} хвостов</span></div>
      <div class="track"><i style="width:${Math.max(5, Math.round(w.tails.length / max * 100))}%"></i></div>
      <div class="badge-line"><span>без попытки ${n(w.tails.filter((o) => !o.firstAttemptDate).length)}</span><span>client issue ${n(w.tails.filter((o) => o.isClientIssue).length)}</span><span>avg age ${days(avg(w.tails, (o) => o.ageDays))}</span></div>
    </button>`).join("") || `<div class="empty">Хвостов 7+ дней в выбранном периоде нет.</div>`}</div>
  </article>`;
}

function avg(rows, fn) {
  return rows.length ? rows.reduce((sum, row) => sum + (fn(row) || 0), 0) / rows.length : 0;
}

function statusDonut(orders, previousOrders) {
  const groups = Object.entries(bucketLabels)
    .filter(([key]) => key !== "all")
    .map(([key, label], index) => ({
      key,
      label,
      value: orders.filter((o) => o.bucket === key).length,
      previous: previousOrders.filter((o) => o.bucket === key).length,
      color: colors[index],
    }))
    .filter((x) => x.value > 0 || x.previous > 0);
  const total = groups.reduce((sum, x) => sum + x.value, 0) || 1;
  let cursor = 0;
  const gradient = groups.map((x) => {
    const start = cursor;
    cursor += (x.value / total) * 100;
    return `${x.color} ${start}% ${cursor}%`;
  }).join(", ");
  return `<article class="panel">
    <div class="section-head"><div><h2>Статусы</h2><p>Доля статусов и изменение к предыдущему периоду.</p></div></div>
    <div class="donut-layout">
      <div class="donut" style="background: conic-gradient(${gradient})"><div><strong>${n(total)}</strong><span>заказов</span></div></div>
      <div class="legend">${groups.map((x) => `<div class="legend-row"><i style="background:${x.color}"></i><span>${x.label}</span><strong>${n(x.value)}</strong><small>${deltaText(x.value, x.previous)}</small></div>`).join("")}</div>
    </div>
  </article>`;
}

function selectedWarehousePanel(currentOrders, previousOrders) {
  const current = currentOrders.filter((o) => o.warehouse === state.selectedWarehouse);
  const previous = previousOrders.filter((o) => o.warehouse === state.selectedWarehouse);
  const cur = summarize(current);
  const prev = summarize(previous);
  const statusRows = [...groupBy(current, (o) => o.status).entries()]
    .map(([status, rows]) => ({ status, count: rows.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return `<article class="panel">
    <div class="section-head"><div><h2>${state.selectedWarehouse}</h2><p>Детали склада за выбранный период</p></div></div>
    <div class="detail-grid">
      <div><span>Заказы</span><strong>${n(cur.total)}</strong><small>${deltaText(cur.total, prev.total)}</small></div>
      <div><span>Активные</span><strong>${n(cur.active)}</strong><small>${deltaText(cur.active, prev.active, "number", true)}</small></div>
      <div><span>Доставлено</span><strong>${n(cur.delivered)}</strong><small>${deltaText(cur.delivered, prev.delivered)}</small></div>
      <div><span>DT AVG</span><strong>${days(cur.avgDt)}</strong><small>${deltaText(cur.avgDt, prev.avgDt, "days", true)}</small></div>
      <div><span>Хвосты 7+</span><strong>${n(cur.tails7)}</strong><small>${deltaText(cur.tails7, prev.tails7, "number", true)}</small></div>
      <div><span>Client issue</span><strong>${n(cur.clientIssue)}</strong><small>${deltaText(cur.clientIssue, prev.clientIssue, "number", true)}</small></div>
    </div>
    <div class="status-list" style="margin-top:12px">${statusRows.map((row) => `<div><strong>${row.status}</strong><br><span>${n(row.count)} заказов</span></div>`).join("") || `<div><span>Нет заказов за выбранный период.</span></div>`}</div>
  </article>`;
}

function ordersPanel(orders) {
  const rows = orders.slice(0, 12);
  return `<article class="panel">
    <div class="section-head"><div><h2>Заказы в выборке</h2><p>Примеры последних строк из Shipox export, ID замаскированы.</p></div></div>
    <div class="card-list">${rows.map((o) => `<button>
      <strong>${o.id}</strong>
      <span>${o.warehouse} / ${o.status}</span>
      <small>создан ${rangeLabel(o.createdDate, o.createdDate)}, обновлен ${o.updatedDate ? rangeLabel(o.updatedDate, o.updatedDate) : "нет даты"}, age ${o.ageDays ?? 0} дн</small>
    </button>`).join("") || `<div class="empty">Нет заказов в выбранной комбинации фильтров.</div>`}</div>
  </article>`;
}

function formulaPanel(compare) {
  return `<article class="panel">
    <div class="section-head"><div><h2>Сравнение</h2><p>${compare.label}: ${rangeLabel(compare.from, compare.to)}</p></div></div>
    <div class="formula-list">
      <div><strong>Период</strong><span>Все KPI, склады, статусы и хвосты считаются по дате создания заказа внутри выбранного диапазона.</span></div>
      <div><strong>День</strong><span>Если выбран один день, сравнение идет с таким же днем прошлой недели.</span></div>
      <div><strong>Неделя / месяц / диапазон</strong><span>Сравнение идет с предыдущим отрезком такой же длины.</span></div>
      <div><strong>Хвосты</strong><span>Сейчас хвосты = активные заказы возрастом 7+ дней.</span></div>
    </div>
  </article>`;
}

function setPreset(mode) {
  const latest = snapshot.availableRange.to;
  if (mode === "today") {
    state.dateFrom = latest;
    state.dateTo = latest;
  } else if (mode === "7") {
    state.dateFrom = addDays(latest, -6);
    state.dateTo = latest;
  } else if (mode === "30") {
    state.dateFrom = addDays(latest, -29);
    state.dateTo = latest;
  } else {
    state.dateFrom = snapshot.availableRange.from;
    state.dateTo = snapshot.availableRange.to;
  }
  render();
}

function controls(compare) {
  const warehouses = snapshot.warehouses.map((w) => `<option value="${w}">${w}</option>`).join("");
  return `<section class="command">
    <div class="topbar">
      <div class="brand"><div class="brand-mark">TEZ</div><div><h1>TEZ / Shipox Control Tower</h1><p>Рабочая интернет-версия TEZ dashboard: даты, сравнения, склады, статусы и хвосты 7+.</p></div></div>
      <div class="meta"><span>PROD</span><a class="refresh-action" href="${UPDATE_WORKFLOW_URL}" target="_blank" rel="noreferrer">Обновить</a><span>${snapshot.sourceCsv}</span><span>обновлено ${rangeLabel(snapshot.generatedAt.slice(0, 10), snapshot.generatedAt.slice(0, 10))}</span></div>
    </div>
    <div class="filters">
      <label><span>С даты</span><input id="dateFrom" type="date" min="${snapshot.availableRange.from}" max="${snapshot.availableRange.to}" value="${state.dateFrom}" /></label>
      <label><span>По дату</span><input id="dateTo" type="date" min="${snapshot.availableRange.from}" max="${snapshot.availableRange.to}" value="${state.dateTo}" /></label>
      <label><span>Склад</span><select id="warehouse"><option value="all">Все склады</option>${warehouses}</select></label>
      <label><span>Статус</span><select id="status">${Object.entries(bucketLabels).map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></label>
      <label><span>Поиск</span><input id="search" placeholder="TEZ..., статус, склад" value="${state.search}" /></label>
      <div class="quick-buttons">
        <button type="button" data-preset="today">Сегодня</button>
        <button type="button" data-preset="7">7 дней</button>
        <button type="button" data-preset="30">30 дней</button>
        <button type="button" data-preset="all">Все</button>
      </div>
      <div class="range-note">Сравнение: ${rangeLabel(compare.from, compare.to)}</div>
    </div>
  </section>`;
}

function render() {
  if (state.dateFrom > state.dateTo) [state.dateFrom, state.dateTo] = [state.dateTo, state.dateFrom];
  const compare = previousRange(state.dateFrom, state.dateTo);
  const currentOrders = ordersForRange(state.dateFrom, state.dateTo);
  const previousOrders = ordersForRange(compare.from, compare.to);
  const current = summarize(currentOrders);
  const previous = summarize(previousOrders);
  const rows = warehouseRows(currentOrders, previousOrders);

  document.querySelector("#app").innerHTML = `
    ${controls(compare)}
    ${kpis(current, previous)}
    <section class="layout">
      <section class="main">
        ${warehouseTable(rows)}
        <div class="split">${tailsPanel(rows)}${statusDonut(currentOrders, previousOrders)}</div>
      </section>
      <aside class="side">
        ${selectedWarehousePanel(currentOrders, previousOrders)}
        ${ordersPanel(currentOrders)}
        ${formulaPanel(compare)}
      </aside>
    </section>`;

  document.querySelector("#warehouse").value = state.warehouse;
  document.querySelector("#status").value = state.status;
  document.querySelector("#dateFrom").addEventListener("change", (event) => { state.dateFrom = event.target.value; render(); });
  document.querySelector("#dateTo").addEventListener("change", (event) => { state.dateTo = event.target.value; render(); });
  document.querySelector("#warehouse").addEventListener("change", (event) => {
    state.warehouse = event.target.value;
    if (event.target.value !== "all") state.selectedWarehouse = event.target.value;
    render();
  });
  document.querySelector("#status").addEventListener("change", (event) => { state.status = event.target.value; render(); });
  document.querySelector("#search").addEventListener("input", (event) => { state.search = event.target.value; render(); });
  document.querySelectorAll("[data-preset]").forEach((node) => node.addEventListener("click", () => setPreset(node.dataset.preset)));
  document.querySelectorAll("[data-wh]").forEach((node) => node.addEventListener("click", () => {
    state.selectedWarehouse = node.getAttribute("data-wh");
    render();
  }));
}

render();
