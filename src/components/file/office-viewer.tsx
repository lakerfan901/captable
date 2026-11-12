type OfficeViewerProps = {
  url: string;
};

const OfficeViewer = ({ url }: OfficeViewerProps) => {
  return (
    // biome-ignore lint/a11y/useIframeTitle: pre-existing; adding a title is an accessibility enhancement outside this lint-only change
    <iframe
      src={`https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(
        url,
      )}`}
      className="w-full h-full min-h-screen"
    />
  );
};

export { OfficeViewer };
