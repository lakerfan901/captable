import type Stripe from "stripe";
import { env } from "@/env";
import { invariant } from "@/lib/error";
import { checkMembership } from "@/server/auth";
import { createOrRetrieveCustomer, stripe } from "@/server/stripe";
import { withAuth } from "@/trpc/api/trpc";
import { ZodCheckoutMutationSchema } from "../schema";

export const checkoutProcedure = withAuth
  .input(ZodCheckoutMutationSchema)
  .mutation(async ({ ctx, input }) => {
    const { priceId, priceType } = input;
    const { db, session } = ctx;

    const { stripeSessionId, url } = await db.$transaction(async (tx) => {
      const { companyId } = await checkMembership({ session, tx });

      let customer: string;
      try {
        customer = await createOrRetrieveCustomer({
          tx,
          companyId,
          email: "",
        });
      } catch (err) {
        console.error(err);
        throw new Error("Unable to access customer record.");
      }

      const params: Stripe.Checkout.SessionCreateParams = {
        allow_promotion_codes: true,
        billing_address_collection: "required",
        customer,
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        mode: priceType === "recurring" ? "subscription" : "payment",
        success_url: `${env.NEXT_PUBLIC_BASE_URL}/${session.user.companyPublicId}/settings/billing`,
      };

      let stripeSession: Stripe.Checkout.Session | undefined;
      try {
        stripeSession = await stripe.checkout.sessions.create(params);
      } catch (err) {
        console.error(err);
        throw new Error("Unable to create checkout session.");
      }

      invariant(stripeSession, "session not found");

      // `url` is the hosted Checkout page; newer Stripe.js releases no longer
      // offer redirectToCheckout, so clients can redirect to it directly.
      return { stripeSessionId: stripeSession.id, url: stripeSession.url };
    });

    return { stripeSessionId, url };
  });
