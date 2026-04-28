import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  // Try multiple possible paths for the public directory
  const candidates = [
    path.resolve(__dirname, "public"),
    path.resolve(process.cwd(), "dist", "public"),
    path.resolve(process.cwd(), "public"),
  ];
  const distPath = candidates.find(p => fs.existsSync(p));
  if (!distPath) {
    throw new Error(
      `Could not find the build directory. Tried: ${candidates.join(", ")}`
    );
  }

  console.log(`[static] Serving from: ${distPath}`);
  app.use(express.static(distPath));

  // SPA fallback — send index.html for all non-API routes
  app.use((req: any, res: any, next: any) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
