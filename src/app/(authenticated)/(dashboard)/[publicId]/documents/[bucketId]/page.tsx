import FileIcon from "@/components/common/file-icon";
import FilePreview from "@/components/file/preview";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { isKeyInCompanyNamespace } from "@/lib/upload-authorization";
import { checkMembership, withServerComponentSession } from "@/server/auth";
import { db } from "@/server/db";
import { getPresignedGetUrl } from "@/server/file-uploads";
import { RiArrowLeftSLine } from "@remixicon/react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";

const DocumentPreview = async (props: {
  params: Promise<{ publicId: string; bucketId: string }>;
}) => {
  const params = await props.params;

  const { publicId, bucketId } = params;

  const session = await withServerComponentSession();
  const { companyId } = await checkMembership({ session, tx: db }).catch(
    () => ({ companyId: null }),
  );

  if (!companyId) {
    return notFound();
  }

  const document = await db.document.findFirst({
    where: {
      bucketId,
      companyId,
      company: { publicId },
    },

    include: {
      bucket: true,
      company: { select: { id: true, publicId: true } },
    },
  });

  // The row must be this company's and so must the object it points at.
  if (
    !document ||
    !document.bucket ||
    !isKeyInCompanyNamespace(document.bucket.key, document.company)
  ) {
    return notFound();
  }

  const file = document.bucket;
  const remoteFile = await getPresignedGetUrl(file.key);

  return (
    <Fragment>
      <div className="mb-5 flex">
        <Link href={`/${publicId}/documents`}>
          <Button
            variant="outline"
            size="icon"
            className="-mt-1 mr-3 flex items-center rounded-full"
          >
            <RiArrowLeftSLine className="h-5 w-5" />
          </Button>
        </Link>

        <FileIcon type={file.mimeType} />

        <h1 className="ml-3 text-2xl font-semibold tracking-tight">
          <span className="text-primary/60">{file.name}</span>
        </h1>
      </div>

      <Card className="p-5">
        <FilePreview
          name={file.name}
          url={remoteFile.url}
          mimeType={file.mimeType}
        />
      </Card>
    </Fragment>
  );
};

export default DocumentPreview;
