#!/usr/bin/env node
// Copies the pdf.js worker that matches the installed react-pdf into /public.
// Run this (`pnpm copy:pdfjs`) whenever react-pdf is upgraded: the worker
// version must match the pdfjs-dist version react-pdf depends on.
const path = require("node:path");
const fs = require("node:fs");

// pdfjs-dist is a dependency of react-pdf, so resolve it from there.
const pdfjsDistPath = path.dirname(
  require.resolve("pdfjs-dist/package.json", {
    paths: [require.resolve("react-pdf/package.json")],
  }),
);

const pdfWorkerPath = path.join(pdfjsDistPath, "build", "pdf.worker.min.mjs");

fs.copyFileSync(pdfWorkerPath, "./public/pdf.worker.min.mjs");
