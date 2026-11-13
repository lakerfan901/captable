"use client";

import dynamic from "next/dynamic";

// react-pdf (pdf.js) reads `document` and `window` while its module is
// evaluated, so a server render throws ("document is not defined") and the
// page answers HTTP 500. The viewer is loaded in the browser only.
export const PdfPreview = dynamic(
  () => import("@/components/ui/pdf-viewer").then((m) => m.PdfViewer),
  { ssr: false },
);
