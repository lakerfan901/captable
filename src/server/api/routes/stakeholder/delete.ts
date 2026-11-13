import { z } from "@hono/zod-openapi";
import { ApiError } from "../../error";

import { authMiddleware, withAuthApiV1 } from "../../utils/endpoint-creator";

const ParamsSchema = z.object({
  id: z.string().openapi({
    param: {
      name: "id",
      in: "path",
    },
    description: "Stakeholder ID",
    type: "string",
    example: "clyabgufg004u5tbtnz0r4cax",
  }),
  companyId: z.string().openapi({
    param: {
      name: "companyId",
      in: "path",
    },
    description: "Company ID",
    type: "string",
    example: "clxwbok580000i7nge8nm1ry0",
  }),
});

const ResponseSchema = z.object({
  message: z.string(),
});

export const _delete = withAuthApiV1
  .createRoute({
    summary: "Delete a stakeholder",
    description: "Remove a stakeholder from a company by ID.",
    tags: ["Stakeholder"],
    method: "delete",
    path: "/v1/{companyId}/stakeholders/{id}",
    middleware: [authMiddleware()],
    request: { params: ParamsSchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: ResponseSchema,
          },
        },
        description: "Confirmation that the stakeholder has been removed.",
      },
    },
  })
  .handler(async (c) => {
    const { db, audit, client } = c.get("services");
    const { membership } = c.get("session");
    const { requestIp, userAgent } = client;
    const { id } = c.req.valid("param");

    await db.$transaction(async (tx) => {
      const stakeholder = await tx.stakeholder.findUnique({
        where: {
          id,
          companyId: membership.companyId,
        },
        select: {
          id: true,
          companyId: true,
          name: true,
        },
      });

      if (!stakeholder) {
        throw new ApiError({
          code: "NOT_FOUND",
          message: "No stakeholder with the provided Id",
        });
      }

      // A holder named on a unit transfer is part of the ledger's history:
      // deleting it would leave units the register can no longer attribute.
      const transfer = await tx.unitTransfer.findFirst({
        where: {
          companyId: stakeholder.companyId,
          OR: [
            { fromStakeholderId: stakeholder.id },
            { toStakeholderId: stakeholder.id },
          ],
        },
        select: { id: true },
      });
      if (transfer) {
        throw new ApiError({
          code: "BAD_REQUEST",
          message:
            "This stakeholder is a party to a unit transfer and cannot be deleted.",
        });
      }

      await tx.stakeholder.delete({
        where: {
          id: stakeholder.id,
        },
      });

      await audit.create(
        {
          action: "stakeholder.deleted",
          companyId: membership.companyId,
          actor: { type: "user", id: membership.userId },
          context: {
            requestIp,
            userAgent,
          },
          target: [{ type: "stakeholder", id }],
          summary: `${membership.user.name} deleted the stakeholder ${stakeholder.name} - ${stakeholder.id}`,
        },
        tx,
      );
    });

    return c.json(
      {
        message: "Stakeholder deleted successfully",
      },
      200,
    );
  });
