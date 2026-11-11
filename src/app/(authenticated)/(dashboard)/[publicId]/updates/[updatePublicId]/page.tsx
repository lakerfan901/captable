"use server";
import Editor from "@/components/update/editor-lazy";
import { db } from "@/server/db";

const getUpdate = async (publicId: string) => {
  return await db.update.findFirstOrThrow({
    where: { publicId },
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

  return <Editor companyPublicId={publicId} update={update} mode="edit" />;
};

export default UpdatePage;
