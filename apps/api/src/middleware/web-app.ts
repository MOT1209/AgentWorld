import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

/** Paths owned by the API; the single-page-app fallback must never answer for them. */
const API_PREFIXES = ["/api/", "/health", "/ready"];

function isApiPath(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * Serves the built dashboard from the API process (same origin, so no CORS and no baked-in API URL).
 *
 * Mount it BEFORE the rate limiter: loading the page fetches dozens of static files and must not
 * spend the API budget. Throws at boot when the build is missing, so a mis-set SERVE_WEB fails loudly
 * instead of serving 404s.
 */
export function mountWebApp(app: Express, distDir: string): void {
  const root = resolve(distDir);
  const indexFile = resolve(root, "index.html");
  if (!existsSync(indexFile)) {
    throw new Error(
      `SERVE_WEB is on but ${indexFile} does not exist. Build the dashboard first: npm run build:web`,
    );
  }
  // Hashed build assets are immutable; everything else (index.html, models) revalidates.
  app.use(
    express.static(root, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${resolve(root, "assets")}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  app.get("*", (req: Request, res: Response, next: NextFunction) => {
    // API paths and requests for a file (has an extension) that static did not find stay 404s,
    // so a missing asset is an error and not an HTML page served as JavaScript.
    if (isApiPath(req.path) || extname(req.path) !== "") {
      next();
      return;
    }
    res.sendFile(indexFile);
  });
}
