"use client";

import dynamic from "next/dynamic";

// react-pdf (pdf.js) reads `document` and `window` while its module is
// evaluated, so a server render of the canvas throws ("document is not
// defined") and the page answers HTTP 500. The canvas is loaded in the
// browser only. `ssr: false` is only allowed inside a Client Component.
export const PdfCanvas = dynamic(
  () => import("./pdf-canvas").then((m) => m.PdfCanvas),
  { ssr: false },
);
