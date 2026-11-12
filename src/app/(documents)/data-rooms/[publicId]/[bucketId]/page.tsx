import { RiFolder3Fill as FolderIcon } from "@remixicon/react";
import Link from "next/link";
import { notFound } from "next/navigation";
import FilePreview from "@/components/file/preview";
import { SharePageLayout } from "@/components/share/page-layout";
import { decode, type JWTVerifyResult } from "@/lib/jwt";
import { isKeyInCompanyNamespace } from "@/lib/upload-authorization";
import { db } from "@/server/db";
import { getPresignedGetUrl } from "@/server/file-uploads";

const DataRoomPage = async (props: {
  params: Promise<{ publicId: string; bucketId: string }>;
  searchParams: Promise<{ token: string }>;
}) => {
  const searchParams = await props.searchParams;

  const { token } = searchParams;

  const params = await props.params;

  const { publicId, bucketId } = params;

  let decodedToken: JWTVerifyResult | null = null;

  try {
    decodedToken = await decode(token);
  } catch {
    return notFound();
  }

  const { companyId, dataRoomId, recipientId } = decodedToken.payload;
  if (!companyId || !recipientId || !dataRoomId) {
    return notFound();
  }

  const recipient = await db.dataRoomRecipient.findFirst({
    where: {
      id: recipientId,
      dataRoomId,
    },

    select: {
      id: true,
    },
  });

  if (!recipient) {
    return notFound();
  }

  const dataRoom = await db.dataRoom.findFirst({
    where: {
      publicId,
      id: dataRoomId,
      companyId,
    },

    include: {
      company: true,
      documents: {
        where: { document: { companyId } },
        include: {
          document: {
            include: {
              bucket: true,
            },
          },
        },
      },
    },
  });

  if (!dataRoom) {
    return notFound();
  }

  const dataRoomFile = dataRoom.documents.find(
    (doc) => doc.document.bucket.id === bucketId,
  );

  if (
    dataRoomId !== dataRoom.id ||
    dataRoom?.companyId !== companyId ||
    !dataRoomFile
  ) {
    return notFound();
  }

  const file = dataRoomFile?.document.bucket;

  if (
    !file ||
    !isKeyInCompanyNamespace(file.key, {
      id: dataRoom.company.id,
      publicId: dataRoom.company.publicId,
    })
  ) {
    return notFound();
  }

  const company = dataRoom.company;
  const remoteFile = await getPresignedGetUrl(file.key);

  return (
    <SharePageLayout
      medium="dataRoom"
      company={{
        name: company.name,
        logo: company.logo,
      }}
      title={
        <div className="flex">
          <FolderIcon
            className="mr-3 mt-1 h-6 w-6 text-primary/60"
            aria-hidden="true"
          />

          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="text-primary/60">Data room / </span>
            <Link
              href={`/data-rooms/${publicId}?token=${token}`}
              className="text-primary/60 hover:text-primary/90 hover:underline"
            >
              {dataRoom.name}
            </Link>
            {` / ${file.name}`}
          </h1>
        </div>
      }
    >
      <FilePreview
        name={file.name}
        url={remoteFile.url}
        mimeType={file.mimeType}
      />
    </SharePageLayout>
  );
};

export default DataRoomPage;
