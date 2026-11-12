import Editor from "@/components/update/editor-lazy";
import { checkMembership, withServerComponentSession } from "@/server/auth";
import { db } from "@/server/db";
import { notFound } from "next/navigation";

const getUpdate = async (publicId: string) => {
  const session = await withServerComponentSession();
  const { companyId } = await checkMembership({ session, tx: db });

  return await db.update.findFirst({
    where: { publicId, companyId },
  });
};

const UpdatePage = async (props: {
  params: Promise<{ publicId: string; updatePublicId: string }>;
}) => {
  const params = await props.params;

  const { publicId, updatePublicId } = params;

  if (updatePublicId === "new") {
    return <Editor companyPublicId={publicId} mode="new" />;
  }
  const update = await getUpdate(updatePublicId);

  if (!update) {
    return notFound();
  }

  return <Editor companyPublicId={publicId} update={update} mode="edit" />;
};

export default UpdatePage;
