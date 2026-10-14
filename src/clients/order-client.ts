import type { CheckoutRequest } from "../saga/types.js";
import type { ServiceTokenProvider } from "./service-token-provider.js";

export type CallResult<T> =
  | { ok: true; value: T }
  /** The request was understood and refused (4xx): retrying cannot help. */
  | { ok: false; kind: "rejected"; code: string }
  /** 5xx, timeout, network: the outcome is unknown, retry later with the SAME idempotency key. */
  | { ok: false; kind: "unavailable"; detail: string };

export interface OrderGateway {
  createOrder(input: { sagaId: string; customerId: string; request: CheckoutRequest }): Promise<CallResult<{ orderId: string; totalMinor: bigint; currency: string }>>;
}

export interface PaymentGateway {
  createIntent(input: { sagaId: string; orderId: string; returnUrl: string }): Promise<CallResult<{ paymentId: string; checkoutUrl: string }>>;
}

/** Shared HTTP behaviour: service token, idempotency key, timeout, and result classification. */
async function post<T>(
  tokens: ServiceTokenProvider,
  audience: string,
  url: string,
  body: unknown,
  idempotencyKey: string,
  timeoutMs: number,
  parse: (json: unknown) => T,
): Promise<CallResult<T>> {
  let token: string;
  try {
    token = await tokens.token(audience);
  } catch (err) {
    return { ok: false, kind: "unavailable", detail: `service token: ${(err as Error).message}` };
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, kind: "unavailable", detail: (err as Error).message };
  }
  if (res.status === 401) tokens.invalidate(audience); // e.g. key rotation: fresh token next attempt
  if (res.ok) return { ok: true, value: parse(await res.json()) };
  if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 408 && res.status !== 409 && res.status !== 429) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string };
    return { ok: false, kind: "rejected", code: problem.code ?? `HTTP_${res.status}` };
  }
  return { ok: false, kind: "unavailable", detail: `HTTP ${res.status}` };
}

export class HttpOrderGateway implements OrderGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: ServiceTokenProvider,
    private readonly timeoutMs: number,
  ) {}

  createOrder({ sagaId, customerId, request }: { sagaId: string; customerId: string; request: CheckoutRequest }) {
    return post(
      this.tokens,
      "ecommerce-order-service",
      `${this.baseUrl}/api/v1/orders`,
      {
        customerId,
        sagaId,
        currency: request.currency,
        items: request.items,
        shippingAddress: request.shippingAddress,
        ...(request.couponCode && { couponCode: request.couponCode }),
      },
      // Derived from the saga: a retry after a crash or timeout returns the SAME order.
      `${sagaId}:create-order`,
      this.timeoutMs,
      (json) => {
        const o = (json as { order: { id: string; totals: { grandTotal: { amountMinor: number; currency: string } } } }).order;
        return { orderId: o.id, totalMinor: BigInt(o.totals.grandTotal.amountMinor), currency: o.totals.grandTotal.currency };
      },
    );
  }
}

export class HttpPaymentGateway implements PaymentGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: ServiceTokenProvider,
    private readonly timeoutMs: number,
  ) {}

  createIntent({ sagaId, orderId, returnUrl }: { sagaId: string; orderId: string; returnUrl: string }) {
    return post(
      this.tokens,
      "ecommerce-payment-service",
      `${this.baseUrl}/api/v1/payments/intent`,
      // No amount: the Payment Service reads the authoritative total from the Order Service.
      // sagaId lets its payment events route straight to this saga.
      { orderId, returnUrl, sagaId },
      `${sagaId}:payment-intent`,
      this.timeoutMs,
      (json) => {
        const p = (json as { payment: { id: string; checkoutUrl: string } }).payment;
        return { paymentId: p.id, checkoutUrl: p.checkoutUrl };
      },
    );
  }
}
