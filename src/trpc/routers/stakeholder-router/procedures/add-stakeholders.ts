import { Audit } from "@/server/audit";
import { withAccessControl } from "@/trpc/api/trpc";
import { ZodAddStakeholderArrayMutationSchema } from "../schema";

export const addStakeholdersProcedure = withAccessControl
  .input(ZodAddStakeholderArrayMutationSchema)
  .meta({ policies: { stakeholder: { allow: ["create"] } } })
  .mutation(
    async ({
      ctx: { db, membership, userAgent, requestIp, session },
      input,
    }) => {
      try {
        const { user } = session;
        const { companyId } = membership;

        // Emails are stored lower-cased and are unique per company.
        const data = input.map((stakeholder) => ({
          ...stakeholder,
          email: stakeholder.email.trim().toLowerCase(),
          companyId,
        }));

        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const row of data) {
          if (seen.has(row.email)) duplicates.add(row.email);
          seen.add(row.email);
        }

        const existing = await db.stakeholder.findMany({
          where: { companyId, email: { in: [...seen] } },
          select: { email: true },
        });
        for (const row of existing) duplicates.add(row.email);

        if (duplicates.size) {
          return {
            success: false,
            message: `These emails already exist: ${[...duplicates].join(", ")}`,
          };
        }

        await db.$transaction(async (tx) => {
          const created = await tx.stakeholder.createManyAndReturn({
            data,
            select: { id: true, name: true },
          });

          for (const stakeholder of created) {
            await Audit.create(
              {
                action: "stakeholder.added",
                companyId,
                actor: { type: "user", id: user.id },
                context: {
                  userAgent,
                  requestIp,
                },
                target: [{ type: "stakeholder", id: stakeholder.id }],
                summary: `${user.name} added stakeholder ${stakeholder.name} for the company ID ${companyId}`,
              },
              tx,
            );
          }
        });

        return {
          success: true,
          message: "Stakeholders added successfully!",
        };
      } catch (_error) {
        return {
          success: false,
          message: "Oops, something went wrong. Please try again later.",
        };
      }
    },
  );
