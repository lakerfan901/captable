import "@blocknote/mantine/style.css";
import "@/styles/editor.css";

type UpdatesEditorProps = {
  html: string;
};

const UpdateRenderer = ({ html }: UpdatesEditorProps) => {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: renders editor-generated HTML; not sanitized server-side
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
};

export default UpdateRenderer;
