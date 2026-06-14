const API_URL = "http://localhost:8787";

document.addEventListener("DOMContentLoaded", () => {
  initDashboard();
});

async function initDashboard() {
  try {
    const res = await fetch(`${API_URL}/api/instruments`);
    if (!res.ok) throw new Error("Failed to fetch instruments");
    const instruments = await res.json();
    renderSidebar(instruments);

    if (instruments.length > 0) {
      loadInstrument(instruments[0]);
    }
  } catch (err) {
    console.error("Dashboard error:", err);
    document.getElementById("instruments-list").innerHTML = `
      <div class="px-4 py-3 text-red-400 text-sm bg-red-950/20 border border-red-900/40 rounded-xl">
        Error loading instruments. Make sure wrangler dev is running on port 8787.
      </div>
    `;
  }
}

function renderSidebar(instruments) {
  const container = document.getElementById("instruments-list");
  container.innerHTML = "";

  instruments.forEach(inst => {
    const btn = document.createElement("button");
    btn.className = "sidebar-btn flex items-center justify-between w-full px-4 py-3 text-left rounded-xl transition duration-200 border border-transparent";
    btn.dataset.id = inst.id;
    
    const label = inst.asset_class === "crypto" ? "crypto" : "stock";
    const badgeColor = inst.asset_class === "crypto" ? "badge-crypto" : "badge-stock";

    btn.innerHTML = `
      <div>
        <div class="font-bold text-slate-100">${inst.symbol}</div>
        <div class="text-xs text-slate-400 capitalize">${inst.asset_class.replace("_", " ")}</div>
      </div>
      <span class="text-2xs font-semibold px-2 py-0.5 rounded-full ${badgeColor}">${label}</span>
    `;

    btn.addEventListener("click", () => {
      document.querySelectorAll(".sidebar-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      loadInstrument(inst);
    });

    container.appendChild(btn);
  });

  const first = container.querySelector(".sidebar-btn");
  if (first) first.classList.add("active");
}

async function loadInstrument(inst) {
  const timeframe = inst.asset_class === "crypto" ? "15Min" : "1D";
  
  document.getElementById("active-symbol").innerText = inst.symbol;
  const assetClassBadge = document.getElementById("active-asset-class");
  assetClassBadge.innerText = inst.asset_class.replace("_", " ");
  assetClassBadge.className = `active-badge text-xs px-3 py-1 rounded-full uppercase font-bold tracking-wider ${
    inst.asset_class === "crypto" ? "badge-crypto" : "badge-stock"
  }`;

  setLoadingState(true);

  try {
    // 1. Fetch HOT price data from D1 Database (last 10 days cache)
    const hotRes = await fetch(`${API_URL}/api/bars?instrument_id=${inst.id}&timeframe=${timeframe}`);
    if (!hotRes.ok) throw new Error("Failed to fetch D1 hot bars");
    const hotData = await hotRes.json();
    const hotBars = hotData.bars || [];

    // 2. Fetch COLD historical data from R2 Bucket (queries offloaded via Partytown worker)
    let coldBars = [];
    if (typeof window.queryDuckDB === "function") {
      try {
        coldBars = await window.queryDuckDB(inst.symbol);
      } catch (e) {
        console.log("No historical archive in R2 found yet for", inst.symbol);
      }
    }

    // 3. Merge Hot (D1) and Cold (R2) datasets
    const mergedBars = mergeDatasets(hotBars, coldBars);

    // 4. Calculate unified statistics on the merged dataset
    const unifiedStats = calculateUnifiedStats(mergedBars);

    // 5. In Partytown, forward telemetry event
    if (typeof window.trackEvent === "function") {
      window.trackEvent("view_instrument", {
        symbol: inst.symbol,
        asset_class: inst.asset_class,
        hot_bars_count: hotBars.length,
        cold_bars_count: coldBars.length,
        total_bars_count: mergedBars.length
      });
    }

    renderStats(unifiedStats);
    renderChart(mergedBars);
    renderTable(mergedBars);
    setLoadingState(false);
  } catch (err) {
    console.error("Failed to load instrument data:", err);
    setLoadingState(false);
    showErrorState();
  }
}

function mergeDatasets(hotBars, coldBars) {
  // Map both sets, convert column names if necessary, and deduplicate by time
  const merged = [...hotBars];
  const seenTimes = new Set(hotBars.map(b => b.time));

  coldBars.forEach(b => {
    // Map D1 schema parameters
    const mappedBar = {
      time: b.time,
      open_cents: b.open_cents,
      high_cents: b.high_cents,
      low_cents: b.low_cents,
      close_cents: b.close_cents,
      volume: b.volume,
      timeframe: b.timeframe
    };

    if (!seenTimes.has(mappedBar.time)) {
      merged.push(mappedBar);
      seenTimes.add(mappedBar.time);
    }
  });

  // Sort chronologically
  return merged.sort((a, b) => a.time.localeCompare(b.time));
}

function calculateUnifiedStats(bars) {
  if (bars.length === 0) {
    return { avg_price: null, median: null, min_price: null, max_price: null };
  }

  const closePrices = bars.map(b => b.close_cents);
  const count = closePrices.length;
  const sum = closePrices.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / count);
  const min = Math.min(...closePrices);
  const max = Math.max(...closePrices);

  const sorted = [...closePrices].sort((a, b) => a - b);
  const mid = Math.floor(count / 2);
  const median = count % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

  return {
    avg_price: avg,
    median: median,
    min_price: min,
    max_price: max
  };
}

function setLoadingState(isLoading) {
  const loaders = document.querySelectorAll(".data-loader");
  const contents = document.querySelectorAll(".data-content");
  
  if (isLoading) {
    loaders.forEach(l => l.classList.remove("hidden"));
    contents.forEach(c => c.classList.add("hidden"));
  } else {
    loaders.forEach(l => l.classList.add("hidden"));
    contents.forEach(c => c.classList.remove("hidden"));
  }
}

function showErrorState() {
  document.getElementById("avg-close").innerText = "—";
  document.getElementById("median-close").innerText = "—";
  document.getElementById("low-close").innerText = "—";
  document.getElementById("high-close").innerText = "—";
  document.getElementById("chart-container").innerHTML = `
    <div class="flex items-center justify-center h-full text-slate-500 text-sm">
      No historical price data available. Run ingestion to fetch live bars.
    </div>
  `;
  document.getElementById("bars-table-body").innerHTML = `
    <tr>
      <td colspan="6" class="px-6 py-4 text-center text-sm text-slate-500">
        No price bars returned.
      </td>
    </tr>
  `;
}

function renderStats(stats) {
  document.getElementById("avg-close").innerText = formatCents(stats.avg_price);
  document.getElementById("median-close").innerText = formatCents(stats.median);
  document.getElementById("low-close").innerText = formatCents(stats.min_price);
  document.getElementById("high-close").innerText = formatCents(stats.max_price);
}

function renderChart(bars) {
  const container = document.getElementById("chart-container");
  container.innerHTML = "";

  if (bars.length < 2) {
    container.innerHTML = `
      <div class="flex items-center justify-center h-full text-slate-500 text-sm">
        Insufficient data to render chart (minimum 2 bars required).
      </div>
    `;
    return;
  }

  const width = container.clientWidth || 600;
  const height = container.clientHeight || 280;
  const padding = 20;

  const prices = bars.map(b => b.close_cents);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice || 1;

  const points = bars.map((bar, idx) => {
    const x = padding + (idx / (bars.length - 1)) * (width - padding * 2);
    const y = height - padding - ((bar.close_cents - minPrice) / priceRange) * (height - padding * 2);
    return { x, y, price: bar.close_cents, date: new Date(bar.time).toLocaleDateString() };
  });

  const pathD = points.reduce((acc, p, idx) => {
    return acc + `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y} `;
  }, "");

  const areaD = pathD + `L ${points[points.length - 1].x} ${height - padding} L ${points[0].x} ${height - padding} Z`;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.overflow = "visible";

  svg.innerHTML = `
    <defs>
      <linearGradient id="chart-glow" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f97316" stop-opacity="0.25"></stop>
        <stop offset="100%" stop-color="#f97316" stop-opacity="0.00"></stop>
      </linearGradient>
    </defs>
    
    <line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" stroke="rgba(255,255,255,0.03)" stroke-width="1" />
    <line x1="${padding}" y1="${height / 2}" x2="${width - padding}" y2="${height / 2}" stroke="rgba(255,255,255,0.03)" stroke-width="1" />
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="rgba(255,255,255,0.05)" stroke-width="1" />

    <path d="${areaD}" fill="url(#chart-glow)" />
    <path d="${pathD}" fill="none" stroke="#f97316" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
  `;

  // Draw interactive tooltip dots on hover (show last 15 points to keep UI fast)
  const renderPoints = points.length > 50 ? points.filter((_, i) => i % Math.floor(points.length / 20) === 0) : points;
  renderPoints.forEach(p => {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", p.x.toString());
    circle.setAttribute("cy", p.y.toString());
    circle.setAttribute("r", "4");
    circle.setAttribute("fill", "#f97316");
    circle.setAttribute("stroke", "#1e293b");
    circle.setAttribute("stroke-width", "2");
    circle.style.cursor = "pointer";
    circle.style.transition = "transform 0.1s";

    circle.innerHTML = `<title>${p.date}: ${formatCents(p.price)}</title>`;
    
    circle.addEventListener("mouseenter", () => circle.setAttribute("r", "6"));
    circle.addEventListener("mouseleave", () => circle.setAttribute("r", "4"));

    svg.appendChild(circle);
  });

  container.appendChild(svg);
}

function renderTable(bars) {
  const tbody = document.getElementById("bars-table-body");
  tbody.innerHTML = "";

  if (bars.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="px-6 py-4 text-center text-sm text-slate-500">
          No historical price data recorded.
        </td>
      </tr>
    `;
    return;
  }

  // Show latest 10 bars
  const latestBars = [...bars].reverse().slice(0, 10);
  latestBars.forEach(b => {
    const tr = document.createElement("tr");
    tr.className = "border-b border-white/5 hover:bg-white/2 transition duration-150";

    const dateStr = b.timeframe === "15Min"
      ? new Date(b.time).toLocaleString()
      : new Date(b.time).toLocaleDateString();

    tr.innerHTML = `
      <td class="px-6 py-4 whitespace-nowrap text-sm font-semibold text-slate-300">${dateStr}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-400">${formatCents(b.open_cents)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-emerald-400">${formatCents(b.high_cents)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-rose-400">${formatCents(b.low_cents)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm font-bold text-slate-200">${formatCents(b.close_cents)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-400">${b.volume.toLocaleString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

function formatCents(cents) {
  if (cents === null || cents === undefined) return "—";
  const dollars = cents / 100;
  if (dollars >= 1000) {
    return "$" + dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return "$" + dollars.toFixed(2);
}
