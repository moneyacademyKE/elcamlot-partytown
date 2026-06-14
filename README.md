# Elcamlot Light: Partytown + Bun + Cloudflare Stack

An ultra-lightweight, high-performance financial dashboard client offloading third-party scripts to Web Workers using **Partytown** (@qwik.dev/partytown) and powered by **Bun**, **Cloudflare Workers**, and **Cloudflare D1** (Serverless SQLite).

---

## 🚀 Architectural Overview

To maximize page responsiveness and achieve a perfect **100/100 Lighthouse performance score**, this project implements an edge-native, client-side stack that offloads third-party scripts to Web Workers:

```mermaid
graph TD
    subgraph Browser (Main UI Thread)
        UI[Glassmorphism UI Dashboard]
        PartytownSnippet[Partytown Snippet]
        ProxyLayer[JS Proxy Interceptor]
    end

    subgraph Browser Background Thread
        WorkerThread[Partytown Web Worker]
        Telemetry[Third-Party Analytics Script]
    end

    subgraph Edge Network / Backend
        CFWorker[Cloudflare Workers API]
        D1[Cloudflare D1 Database]
        Ingestion[Datasource Ingest Config]
    end

    UI -->|API Requests| CFWorker
    CFWorker <--> D1
    Ingestion -->|Ingests prices| D1
    
    PartytownSnippet -->|Bootstraps| WorkerThread
    Telemetry -->|Executes inside| WorkerThread
    Telemetry -.->|Synchronous DOM read/write| ProxyLayer
    ProxyLayer <--> UI
```

### Component Details:
1. **Frontend UI**: Built with a clean, zero-dependency glassmorphism interface in static HTML/JS, served via **Vite** and **Bun**, ready for Cloudflare Pages.
2. **Third-Party Script Sandboxing**: Powered by `@qwik.dev/partytown`. All heavy analytical, telemetry, and tracking scripts are executed off the browser's main UI thread in a background Web Worker. Intercepted calls to main thread APIs (like cookies, `window`, or `document`) are handled via synchronous JS Proxies.
3. **Serverless APIs**: Built as a standard **Cloudflare Worker** serving REST endpoints for instruments and historical price bars.
4. **Edge Database**: Backed by **Cloudflare D1** (distributed serverless SQLite database) to store instrument tables and price bars.
5. **Ingestion Pipelines**: Implemented in the worker utilizing **Cloudflare Cron Triggers** to periodically ingest daily equity and 15-minute crypto bars from Alpaca and Alpha Vantage APIs (with resilient fallback logic).

---

## 🛠️ Getting Started

### 1. Install Dependencies
Ensure you have [Bun](https://bun.sh) installed, then run:
```bash
bun install
```

### 2. Configure D1 Database Schema
Initialize the local SQLite D1 database instance and create the tables:
```bash
bunx wrangler d1 execute elcamlot-db --local --file=schema.sql
```

### 3. Start Cloudflare Workers Server
Start the local Wrangler dev server (which emulates D1 and runs the Worker API on port `8787`):
```bash
APCA_API_KEY_ID="your_key" APCA_API_SECRET_KEY="your_secret" bunx wrangler dev
```

### 4. Run Vite Frontend Development Server
In a new terminal window, boot the local static file server (running on port `3001`):
```bash
bun run dev
```
Open `http://localhost:3001` in your browser.

---

## 📊 Ingestion & Trigger Testing

Because cron triggers are not automatically fired during local development, you can test the ingestion and database seeding manually by triggering the endpoints or clicking the buttons in the dashboard header:

* **Trigger Crypto Ingestion (15Min timeframe)**:
  ```bash
  curl -s "http://localhost:8787/api/ingest?type=crypto"
  ```
* **Trigger Equity Ingestion (1D timeframe)**:
  ```bash
  curl -s "http://localhost:8787/api/ingest?type=equity"
  ```

---

## 🧵 Partytown Worker Logs

When viewing the dashboard, click on different instruments. In the sidebar, you will see a **Partytown Worker Logs** console. 
All event tracking telemetry is intercepted by Partytown and executed **exclusively inside the background worker thread**, printing outputs directly to the UI panel and browser developer tools without stealing cycles from UI animations.
