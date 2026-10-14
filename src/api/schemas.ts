import { z } from "../lib/zod.js";
import type { SagaRecord } from "../saga/repository.js";
import { customerStatus, SAGA_STATES } from "../saga/types.js";

const Sku = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,63}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

export const CheckoutRequestSchema = z
  .object({
    items: z
      .array(z.object({ sku: Sku, quantity: z.number().int().min(1).max(1000) }).strict())
      .min(1)
      .max(100)
      .refine((items) => new Set(items.map((i) => i.sku)).size === items.length, "Each SKU may appear only once"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    shippingAddress: z
      .object({
        name: text(200),
        line1: text(200),
        line2: z.string().trim().max(200).optional(),
        city: text(100),
        state: z.string().trim().max(100).optional(),
        postalCode: text(20),
        country: z.string().regex(/^[A-Z]{2}$/),
        phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/),
      })
      .strict(),
    couponCode: z.string().trim().max(32).optional(),
  })
  .strict()
  .openapi("CheckoutRequest", { description: "Prices and totals are never accepted from the browser." });

export const CheckoutStatus = z
  .object({
    sagaId: z.uuid(),
    orderId: z.uuid().nullable(),
    status: z.enum(["PROCESSING", "AWAITING_PAYMENT", "COMPLETED", "CANCELLED", "FAILED", "UNDER_REVIEW"]),
    checkoutUrl: z.string().nullable().openapi({ description: "Present only while AWAITING_PAYMENT" }),
    failureReason: z.string().nullable(),
    statusUrl: z.string(),
  })
  .openapi("CheckoutStatus");

export const SagaIdParam = z.object({ sagaId: z.uuid() });
export const AdminListQuery = z
  .object({ state: z.enum(SAGA_STATES).optional(), limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.uuid().optional() })
  .strict();
export const ResolveRequest = z
  .object({ resolution: z.string().trim().min(1).max(200) })
  .strict()
  .openapi("ResolveRequest");

export const AdminSaga = z
  .object({
    id: z.uuid(),
    customerId: z.uuid(),
    state: z.enum(SAGA_STATES),
    orderId: z.uuid().nullable(),
    reservationId: z.uuid().nullable(),
    paymentId: z.uuid().nullable(),
    total: z.object({ amountMinor: z.number().int(), currency: z.string() }).nullable(),
    failureReason: z.string().nullable(),
    compensation: z.record(z.string(), z.unknown()),
    stepAttempts: z.number().int(),
    deadlineAt: z.iso.datetime().nullable(),
    version: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .openapi("AdminSaga");

export function toCheckoutStatus(s: SagaRecord) {
  const status = customerStatus(s.state);
  return {
    sagaId: s.id,
    orderId: s.orderId,
    status,
    checkoutUrl: status === "AWAITING_PAYMENT" ? s.checkoutUrl : null,
    failureReason: s.failureReason,
    statusUrl: `/api/v1/checkout/${s.id}`,
  };
}

export function toAdminSaga(s: SagaRecord) {
  return {
    id: s.id,
    customerId: s.customerId,
    state: s.state,
    orderId: s.orderId,
    reservationId: s.reservationId,
    paymentId: s.paymentId,
    total: s.totalMinor !== null && s.currency ? { amountMinor: Number(s.totalMinor), currency: s.currency } : null,
    failureReason: s.failureReason,
    compensation: s.compensation as unknown as Record<string, unknown>,
    stepAttempts: s.stepAttempts,
    deadlineAt: s.deadlineAt ? s.deadlineAt.toISOString() : null,
    version: s.version,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    completedAt: s.completedAt ? s.completedAt.toISOString() : null,
  };
}
