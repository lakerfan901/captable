import "@blocknote/mantine/style.css";
import "@/styles/editor.css";
import { sanitizeUpdateHtml } from "@/lib/sanitize-update-html";

type UpdatesEditorProps = {
  html: string;
};

const UpdateRenderer = ({ html }: UpdatesEditorProps) => {
  // Sanitized again at render time so rows stored before sanitize-on-save
  // existed are safe too.
  const safeHtml = sanitizeUpdateHtml(html);

  // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized with an allowlist by sanitizeUpdateHtml
  return <div dangerouslySetInnerHTML={{ __html: safeHtml }} />;
};

export default UpdateRenderer;
