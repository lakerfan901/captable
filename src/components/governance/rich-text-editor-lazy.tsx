"use client";

import dynamic from "next/dynamic";

// The editor depends on browser-only APIs, so it must not be server rendered.
// `ssr: false` is only allowed inside a Client Component.
export const RichTextEditorLazy = dynamic(() => import("./rich-text-editor"), {
  ssr: false,
});

export default RichTextEditorLazy;
