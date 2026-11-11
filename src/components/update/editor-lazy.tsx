"use client";

import dynamic from "next/dynamic";

// The editor depends on browser-only APIs, so it must not be server rendered.
// `ssr: false` is only allowed inside a Client Component since Next.js 15.
const Editor = dynamic(() => import("./editor"), { ssr: false });

export default Editor;
