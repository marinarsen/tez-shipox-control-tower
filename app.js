const snapshot = window.TEZ_SNAPSHOT;
const state = {
  warehouse: "all",
  status: "all",
  period: "all",
  search: "",
  selectedWarehouse: snapshot.warehouses[0]?.warehouse || "TOSHKENT",
};

const bucketLabels = {
  all: "Все статусы",
  activeOps: "В операционной работе",
  clientIssue: "Клиентское уточнение",
  failed: "Failed",
  delivered: "Доставлено",
  returned: "Возврат",
  cancelled: "Отмена",
};

const riskLabels = {
  ok: "OK",
  watch: "Watch",
  risk: "Risk",
  critical: "Critical",
};

const colors = ["#127a5a", "#226fb2", "#d8a21e", "#d66a2f", "#cf3f3f", "#6c5aa8"];
const fmt = new Intl.NumberFormat("ru-RU");
const fmt1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

function n(value) {
  return fmt.format(Math.round(Number(value) || 0));
}

function d(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(value));
}

function pct(value) {
  return `${fmt1.format(value || 0)}%`;
}

function days(value) {
  return value ? `${fmt1.format(value)} дн` : "0 дн";
}

function el(tag, className = "", html = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

function periodStart() {
  const latest = snapshot.daily.at(-1)?.date || new Date().toISOString().slice(0, 10);
  const date = new Date(`${latest}T00:00:00`);
  if (state.period === "7") date.setDate(date.getDate() - 6);
  if (state.period === "14") date.setDate(date.getDate() - 13);
  if (state.period === "30") date.setDate(date.getDate() - 29);
  return state.period === "all" ? "" : date.toISOString().slice(0, 10);
}

function filteredOrders() {
  const start = periodStart();
  const needle = state.search.trim().toLowerCase();
  return snapshot.orders.filter((o) => {
    if (state.warehouse !== "all" && o.warehouse !== state.warehouse) return false;
    if (state.status !== "all" && o.bucket !== state.status) return false;
    if (start && (o.createdAt || "").slice(0, 10) < start) return false;
    if (needle && !`${o.id} ${o.status} ${o.warehouse}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function filteredWarehouses(orders) {
  const allowed = new Set(orders.map((o) => o.warehouse));
  return snapshot.warehouses
    .filter((w) => state.warehouse === "all" ? allowed.has(w.warehouse) : w.warehouse === state.warehouse)
    .map((w) => {
      const local = orders.filter((o) => o.warehouse === w.warehouse);
      const delivered = local.filter((o) => o.isDelivered);
      const active = local.filter((o) => !o.isFinal);
      return {
        ...w,
        totalLocal: local.length,
        activeLocal: active.length,
        deliveredLocal: delivered.length,
        over3dLocal: active.filter((o) => o.ageDays > 3).length,
        clientIssueLocal: active.filter((o) => o.isClientIssue).length,
        avgDtLocal: delivered.length ? delivered.reduce((sum, o) => sum + (o.dtDays || 0), 0) / delivered.length : 0,
      };
    })
    .sort((a, b) => b.activeLocal - a.activeLocal || b.totalLocal - a.totalLocal);
}

function metric(label, value, note, tone = "") {
  return `<article class="metric ${tone}">
    <div class="metric-top"><span>${label}</span></div>
    <strong>${value}</strong>
    <small>${note}</small>
  </article>`;
}

function kpis(orders) {
  const active = orders.filter((o) => !o.isFinal);
  const delivered = orders.filter((o) => o.isDelivered);
  const over3 = active.filter((o) => o.ageDays > 3).length;
  const noAttempt = active.filter((o) => !o.firstAttemptAt && o.ageDays > 3).length;
  const clientIssue = active.filter((o) => o.isClientIssue).length;
  const avgDt = delivered.length ? delivered.reduce((sum, o) => sum + (o.dtDays || 0), 0) / delivered.length : 0;
  const within3 = delivered.length ? delivered.filter((o) => o.dtDays <= 3).length / delivered.length * 100 : 0;
  return `<section class="kpis">
    ${metric("Всего заказов", n(orders.length), "в текущем snapshot", "info")}
    ${metric("Активные", n(active.length), "не финальные статусы", active.length > 3000 ? "warn" : "")}
    ${metric("Доставлено", n(delivered.length), `${pct(within3)} в 3 дня`, "")}
    ${metric("Без 1-й попытки 3+ дня", n(noAttempt), "операционный фокус", noAttempt ? "risk" : "")}
    ${metric("Хвосты 3+ дня", n(over3), "активные заказы старше SLA", over3 > 500 ? "bad" : "warn")}
    ${metric("Клиентское уточнение", n(clientIssue), "адрес, телефон, перенос", clientIssue ? "warn" : "")}
    ${metric("DT AVG", days(avgDt), "created → delivered", "info")}
    ${metric("Возврат / отмена", n(orders.filter((o) => o.isReturned || o.isCancelled).length), "финальные не-доставки", "risk")}
  </section>`;
}

function statusDonut(orders) {
  const groups = Object.entries(bucketLabels)
    .filter(([key]) => key !== "all")
    .map(([key, label], index) => ({ key, label, value: orders.filter((o) => o.bucket === key).length, color: colors[index] }))
    .filter((x) => x.value > 0);
  const total = groups.reduce((sum, x) => sum + x.value, 0) || 1;
  let cursor = 0;
  const gradient = groups.map((x) => {
    const start = cursor;
    cursor += x.value / total * 100;
    return `${x.color} ${start}% ${cursor}%`;
  }).join(", ");
  return `<article class="panel">
    <div class="section-head"><div><h2>Статусы</h2><p>Та же классификация, что в TEZ dashboard: финальные, клиентские и операционные статусы.</p></div></div>
    <div class="donut-layout">
      <div class="donut" style="background: conic-gradient(${gradient})"><div><strong>${n(total)}</strong><span>заказов</span></div></div>
      <div class="legend">${groups.map((x) => `<div class="legend-row"><i style="background:${x.color}"></i><span>${x.label}</span><strong>${pct(x.value / total * 100)}</strong></div>`).join("")}</div>
    </div>
  </article>`;
}

function warehouseTable(rows) {
  const max = Math.max(1, ...rows.map((w) => w.activeLocal));
  return `<article class="panel">
    <div class="section-head">
      <div><h2>Склады</h2><p>ORDERS_CURRENT: active, delivered, client issue, tails и DT по складам.</p></div>
      <div class="tabs"><button class="active">PROD</button></div>
    </div>
    <div class="table-shell"><table class="table">
      <thead><tr><th>Склад</th><th>Risk</th><th>Активные</th><th>Доставлено</th><th>Client issue</th><th>3+ дня</th><th>Без попытки</th><th>DT</th><th>7d created</th></tr></thead>
      <tbody>${rows.map((w) => `<tr data-wh="${w.warehouse}" class="${state.selectedWarehouse === w.warehouse ? "selected" : ""}">
        <td><strong>${w.warehouse}</strong><div class="track"><i style="width:${Math.max(4, Math.round(w.activeLocal / max * 100))}%"></i></div></td>
        <td><span class="risk risk-${w.risk}">${riskLabels[w.risk]}</span></td>
        <td>${n(w.activeLocal)}</td>
        <td>${n(w.deliveredLocal)}</td>
        <td>${n(w.clientIssueLocal)}</td>
        <td>${n(w.over3dLocal)}</td>
        <td>${n(w.noFirstAttempt3d)}</td>
        <td>${days(w.avgDtLocal)}</td>
        <td>${n(w.created7d)}</td>
      </tr>`).join("")}</tbody>
    </table></div>
  </article>`;
}

function timelines(orders) {
  const map = new Map(snapshot.daily.map((d) => [d.date, { ...d }]));
  const rows = [...map.values()].slice(-16);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.created, r.delivered)));
  return `<article class="panel">
    <div class="section-head"><div><h2>Динамика</h2><p>Создано, доставлено и active EOD по дням.</p></div></div>
    <div class="timeline">${rows.map((r) => `<div class="timeline-row">
      <span>${r.date.slice(5).split("-").reverse().join(".")}</span>
      <div class="track"><i style="width:${Math.max(3, Math.round(Math.max(r.created, r.delivered) / max * 100))}%"></i></div>
      <strong>${n(r.created)}</strong>
      <small>${n(r.delivered)} delivered</small>
    </div>`).join("")}</div>
  </article>`;
}

function bars(rows) {
  const top = rows.slice(0, 8);
  const max = Math.max(1, ...top.map((w) => w.over3dLocal));
  return `<article class="panel">
    <div class="section-head"><div><h2>Хвосты</h2><p>Активные заказы старше 3 дней и без первой попытки.</p></div></div>
    <div class="bars">${top.map((w) => `<button class="bar-card" data-wh="${w.warehouse}">
      <div class="row"><strong>${w.warehouse}</strong><span>${n(w.over3dLocal)} / ${n(w.noFirstAttempt3d)} без попытки</span></div>
      <div class="track"><i style="width:${Math.max(5, Math.round(w.over3dLocal / max * 100))}%"></i></div>
      <div class="badge-line"><span>active ${n(w.activeLocal)}</span><span>client issue ${n(w.clientIssueLocal)}</span><span>old 7+ ${n(w.over7d)}</span></div>
    </button>`).join("")}</div>
  </article>`;
}

function selectedWarehousePanel() {
  const w = snapshot.warehouses.find((x) => x.warehouse === state.selectedWarehouse) || snapshot.warehouses[0];
  const statusRows = Object.entries(w.statuses).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return `<article class="panel">
    <div class="section-head"><div><h2>${w.warehouse}</h2><p>Детали выбранного склада</p></div><span class="risk risk-${w.risk}">${riskLabels[w.risk]}</span></div>
    <div class="detail-grid">
      <div><span>Активные</span><strong>${n(w.active)}</strong></div>
      <div><span>Доставлено</span><strong>${n(w.delivered)}</strong></div>
      <div><span>Client issue</span><strong>${n(w.clientIssue)}</strong></div>
      <div><span>3+ дня</span><strong>${n(w.over3d)}</strong></div>
      <div><span>Без 1-й попытки</span><strong>${n(w.noFirstAttempt3d)}</strong></div>
      <div><span>DT AVG</span><strong>${days(w.avgDt)}</strong></div>
    </div>
    <div class="status-list" style="margin-top:12px">${statusRows.map(([label, value]) => `<div><strong>${label}</strong><br><span>${n(value)} заказов</span></div>`).join("")}</div>
  </article>`;
}

function ordersPanel(orders) {
  const rows = orders.slice(0, 12);
  return `<article class="panel">
    <div class="section-head"><div><h2>Заказы в выборке</h2><p>Примеры последних строк из Shipox export.</p></div></div>
    <div class="card-list">${rows.map((o) => `<button>
      <strong>${o.id}</strong>
      <span>${o.warehouse} / ${o.status}</span>
      <small>создан ${d(o.createdAt)}, обновлен ${d(o.updatedAt)}, age ${o.ageDays ?? 0} дн</small>
    </button>`).join("")}</div>
  </article>`;
}

function formulaPanel() {
  return `<article class="panel">
    <div class="section-head"><div><h2>Откуда цифры</h2><p>Повторяет расчетную структуру TEZ Apps Script dashboard.</p></div></div>
    <div class="formula-list">
      <div><strong>ORDERS_MASTER</strong><span>финальные статусы: Order Completed, Order Cancelled, Returned to origin; активные считаются отдельно.</span></div>
      <div><strong>DT / 1st Attempt</strong><span>считается от Created at до Delivered / первой попытки; DT Net в рабочем файле остается чистой stock-impact метрикой.</span></div>
      <div><strong>TAILS</strong><span>операционный фокус: активные старше 3 дней, 7+ дней и заказы без первой попытки.</span></div>
      <div><strong>STOCK_PLAN</strong><span>логика TEZ сохранена как блок: burn до ближайшей пятницы + 7 дней резерва; для веб-страницы нужен экспорт MOVEMENTS, чтобы показать реальные SEND NOW.</span></div>
    </div>
  </article>`;
}

function controls() {
  const warehouses = snapshot.warehouses.map((w) => `<option value="${w.warehouse}">${w.warehouse}</option>`).join("");
  return `<section class="command">
    <div class="topbar">
      <div class="brand"><div class="brand-mark">TEZ</div><div><h1>TEZ / Shipox Control Tower</h1><p>Интернет-версия текущего TEZ dashboard: заказы, склады, статусы, хвосты и сроки.</p></div></div>
      <div class="meta"><span>PROD</span><span>${snapshot.sourceCsv}</span><span>обновлено ${d(snapshot.generatedAt)}</span></div>
    </div>
    <div class="filters">
      <label><span>Период</span><select id="period"><option value="all">Все данные</option><option value="7">7 дней</option><option value="14">14 дней</option><option value="30">30 дней</option></select></label>
      <label><span>Склад</span><select id="warehouse"><option value="all">Все склады</option>${warehouses}</select></label>
      <label><span>Статус</span><select id="status">${Object.entries(bucketLabels).map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></label>
      <label><span>Поиск</span><input id="search" placeholder="TEZ..., статус, склад" /></label>
      <div class="range-note">Shipox API rows: ${n(snapshot.sourceExport.rowsWritten || snapshot.kpis.total)}</div>
    </div>
  </section>`;
}

function render() {
  const orders = filteredOrders();
  const warehouses = filteredWarehouses(orders);
  document.querySelector("#app").innerHTML = `
    ${controls()}
    ${kpis(orders)}
    <section class="layout">
      <section class="main">
        ${warehouseTable(warehouses)}
        <div class="split">${bars(warehouses)}${statusDonut(orders)}</div>
        ${timelines(orders)}
      </section>
      <aside class="side">
        ${selectedWarehousePanel()}
        ${ordersPanel(orders)}
        ${formulaPanel()}
      </aside>
    </section>`;

  document.querySelector("#period").value = state.period;
  document.querySelector("#warehouse").value = state.warehouse;
  document.querySelector("#status").value = state.status;
  document.querySelector("#search").value = state.search;
  document.querySelector("#period").addEventListener("change", (e) => { state.period = e.target.value; render(); });
  document.querySelector("#warehouse").addEventListener("change", (e) => { state.warehouse = e.target.value; if (e.target.value !== "all") state.selectedWarehouse = e.target.value; render(); });
  document.querySelector("#status").addEventListener("change", (e) => { state.status = e.target.value; render(); });
  document.querySelector("#search").addEventListener("input", (e) => { state.search = e.target.value; render(); });
  document.querySelectorAll("[data-wh]").forEach((node) => {
    node.addEventListener("click", () => {
      state.selectedWarehouse = node.getAttribute("data-wh");
      render();
    });
  });
}

render();
