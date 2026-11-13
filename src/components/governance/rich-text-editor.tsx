"use client";

import "@/styles/editor.css";
import type { PartialBlock } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

// BlockNote editor for governance documents (03-governance.md G10). Stores
// block JSON only; the server normalizes it (G2). Load it through
// `rich-text-editor-lazy.tsx`, never directly.

export interface RichTextEditorProps {
  initialBlocks: unknown[];
  onChange: (blocks: unknown[]) => void;
  /** false: shown read-only (a viewer without the write permission). */
  editable?: boolean;
}

export default function RichTextEditor({
  initialBlocks,
  onChange,
  editable = true,
}: RichTextEditorProps) {
  const editor = useCreateBlockNote({
    initialContent:
      initialBlocks.length > 0 ? (initialBlocks as PartialBlock[]) : undefined,
  });

  return (
    <BlockNoteView
      className="py-5"
      editor={editor}
      editable={editable}
      theme="light"
      onChange={() => onChange(editor.document)}
    />
  );
}
