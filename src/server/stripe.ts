import { env } from "@/env";
import { invariant } from "@/lib/error";
import {
  PricingPlanInterval,
  PricingType,
  SubscriptionStatus,
} from "@/prisma/enums";
import Stripe from "stripe";
import { type TPrismaOrTransaction, db } from "./db";

const toDateTime = (secs: number) => {
  const t = new Date(+0); // Unix epoch start.
  t.setSeconds(secs);
  return t;
};

// Billing is optional (STRIPE_API_KEY may be unset). stripe-node now throws
// when constructed without a key, so fall back to a placeholder: requests then
// fail with an authentication error, as they did with the empty key before.
const STRIPE_API_KEY_NOT_CONFIGURED = "sk_not_configured";

// Pinned to the API version that this stripe-node major is generated for, so
// the TypeScript types match the responses. Bump it together with `stripe`.
export const stripe = new Stripe(
  env.STRIPE_API_KEY ?? STRIPE_API_KEY_NOT_CONFIGURED,
  {
    typescript: true,
    apiVersion: "2026-10-28.endive",
  },
);

export { Stripe };

export async function upsertProductRecord(product: Stripe.Product) {
  const productData = {
    id: product.id,
    active: product.active,
    name: product.name,
    description: product.description,
    metadata: product.metadata,
  };

  await db.billingProduct.upsert({
    create: productData,
    update: productData,
    where: {
      id: product.id,
    },
  });
}

export async function deleteProductRecord(product: Stripe.Product) {
  await db.billingProduct.delete({
    where: {
      id: product.id,
    },
  });
}

export async function deletePriceRecord(price: Stripe.Price) {
  await db.billingPrice.delete({
    where: {
      id: price.id,
    },
  });
}

const TRIAL_PERIOD_DAYS = 0;

// Stripe's enums are open-ended (new values can appear without an SDK
// release); the database enums are not.
const toPricingType = (type: Stripe.Price.Type): PricingType => {
  invariant(
    Object.hasOwn(PricingType, type),
    `Unsupported Stripe price type: ${type}`,
  );
  return type as PricingType;
};

const toPricingPlanInterval = (
  interval: Stripe.Price.Recurring.Interval | undefined,
): PricingPlanInterval | undefined => {
  if (interval === undefined) return undefined;
  invariant(
    Object.hasOwn(PricingPlanInterval, interval),
    `Unsupported Stripe price interval: ${interval}`,
  );
  return interval as PricingPlanInterval;
};

const toSubscriptionStatus = (
  status: Stripe.Subscription.Status,
): SubscriptionStatus => {
  invariant(
    Object.hasOwn(SubscriptionStatus, status),
    `Unsupported Stripe subscription status: ${status}`,
  );
  return status as SubscriptionStatus;
};

export async function upsertPriceRecord(price: Stripe.Price) {
  const priceData = {
    id: price.id,
    productId: typeof price.product === "string" ? price.product : "",
    active: price.active,
    currency: price.currency,
    type: toPricingType(price.type),
    unitAmount: price.unit_amount,
    interval: toPricingPlanInterval(price.recurring?.interval),
    intervalCount: price.recurring?.interval_count,
    trialPeriodDays: price.recurring?.trial_period_days ?? TRIAL_PERIOD_DAYS,
  };

  await db.billingPrice.upsert({
    create: priceData,
    update: priceData,
    where: {
      id: price.id,
    },
  });
}

export const manageSubscriptionStatusChange = async (
  subscriptionId: string,
  customerId: string,
  createAction = false,
) => {
  const customer = await db.billingCustomer.findFirst({
    where: { id: customerId },
  });

  invariant(customer?.id, "Customer lookup failed");

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["default_payment_method"],
  });

  const item = subscription.items.data[0];

  invariant(item, "item not found");

  const id = subscription.id;

  const data = {
    customerId: customer.id,
    metadata: subscription.metadata,
    status: toSubscriptionStatus(subscription.status),
    priceId: item.price.id,
    quantity: item.quantity ?? 1,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: subscription.cancel_at
      ? toDateTime(subscription.cancel_at)
      : undefined,
    canceledAt: subscription.canceled_at
      ? toDateTime(subscription.canceled_at)
      : undefined,
    // Since API version 2025-03-31.basil the billing period lives on the
    // subscription item rather than the subscription.
    currentPeriodStart: item.current_period_start
      ? toDateTime(item.current_period_start)
      : undefined,
    currentPeriodEnd: item.current_period_end
      ? toDateTime(item.current_period_end)
      : undefined,
    created: toDateTime(subscription.created),
    endedAt: subscription.ended_at
      ? toDateTime(subscription.ended_at)
      : undefined,
    trialStart: subscription.trial_start
      ? toDateTime(subscription.trial_start)
      : undefined,
    trialEnd: subscription.trial_end
      ? toDateTime(subscription.trial_end)
      : undefined,
  };

  await db.billingSubscription.upsert({
    create: { ...data, id },
    update: data,
    where: {
      id,
    },
  });
};

interface upsertCustomerOptions {
  customerId: string;
  companyId: string;
  tx: TPrismaOrTransaction;
}

async function upsertCustomer({
  tx,
  companyId,
  customerId,
}: upsertCustomerOptions) {
  const data = { companyId, id: customerId };
  const customer = await tx.billingCustomer.upsert({
    where: data,
    update: data,
    create: data,
  });

  return customer.id;
}

interface createCustomerInStripeOptions {
  companyId: string;
  email: string;
}

const createCustomerInStripe = async ({
  email,
  companyId,
}: createCustomerInStripeOptions) => {
  const customerData = { metadata: { companyId }, email: email };
  const newCustomer = await stripe.customers.create(customerData);

  invariant(newCustomer, "Stripe customer creation failed.");

  return newCustomer.id;
};

interface createOrRetrieveCustomerOptions {
  companyId: string;
  tx: TPrismaOrTransaction;
  email: string;
}

export async function createOrRetrieveCustomer({
  companyId,
  tx,
  email,
}: createOrRetrieveCustomerOptions) {
  const existingCustomer = await tx.billingCustomer.findFirst({
    where: { companyId },
  });
  let stripeCustomerId: string | undefined;

  if (existingCustomer?.id) {
    const existingStripeCustomer = await stripe.customers.retrieve(
      existingCustomer.id,
    );
    stripeCustomerId = existingStripeCustomer.id;
  } else {
    const stripeCustomers = await stripe.customers.list({ email: email });

    stripeCustomerId = stripeCustomers?.data?.[0]
      ? stripeCustomers.data[0].id
      : undefined;
  }

  const stripeId = stripeCustomerId
    ? stripeCustomerId
    : await createCustomerInStripe({ email, companyId });

  if (existingCustomer && stripeCustomerId) {
    await tx.billingCustomer.update({
      where: {
        id: existingCustomer.id,
      },
      data: {
        id: stripeCustomerId,
      },
    });

    return stripeCustomerId;
  }
  const upsertedStripeCustomer = await upsertCustomer({
    tx,
    companyId,
    customerId: stripeId,
  });

  return upsertedStripeCustomer;
}
