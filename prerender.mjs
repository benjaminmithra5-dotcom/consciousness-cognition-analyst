// Runs after `vite build`. Serves the freshly built dist/ folder on a
// local port, opens each real route in headless Chromium, waits for
// the app to actually render its content (not just for the network to
// go quiet), and writes the final, fully rendered HTML to disk as a
// real index.html for that route. This is what lets a crawler that
// never executes JavaScript (including most AI search tools) see the
// complete page content, not an empty shell.
import puppeteer from "puppeteer";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "./routes.config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");
const PORT = 4173;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".xml": "application/xml", ".txt": "text/plain",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

// A tiny static file server with SPA fallback: any request for a path
// that isn't a real file on disk gets the built index.html instead,
// so client side routing can take over, exactly like a real host does.
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      let filePath = path.join(DIST_DIR, urlPath);

      if (urlPath === "/" || !path.extname(urlPath)) {
        const asDirIndex = path.join(DIST_DIR, urlPath, "index.html");
        filePath = fs.existsSync(asDirIndex) ? asDirIndex : path.join(DIST_DIR, "index.html");
      }

      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error("dist/ not found. Run `vite build` before prerendering.");
    process.exit(1);
  }

  console.log("Starting local server for the build...");
  const server = await startServer();

  console.log("Launching headless browser...");
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });

  for (const { path: routePath } of ROUTES) {
    const page = await browser.newPage();
    const url = `http://localhost:${PORT}${routePath}`;
    console.log(`Prerendering ${routePath} ...`);

    try {
      await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

      // Wait until the app has actually rendered content and set a
      // real title, rather than capturing the page before React has
      // finished its first render.
      await page.waitForFunction(
        () => document.getElementById("root")?.children.length > 0 && document.title.length > 0,
        { timeout: 15000 }
      );

      const html = await page.content();
      const outDir = routePath === "/" ? DIST_DIR : path.join(DIST_DIR, routePath);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "index.html"), html);
    } catch (err) {
      console.error(`Failed to prerender ${routePath}:`, err.message);
      await page.close();
      await browser.close();
      server.close();
      process.exit(1);
    }

    await page.close();
  }

  await browser.close();
  server.close();
  console.log(`Prerendered ${ROUTES.length} routes successfully.`);
}

main();
