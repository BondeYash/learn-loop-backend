// Synthetic provider only. No credentials, SDK or external requests.
import crypto from "node:crypto";
export function providerFixture() {
  const orders = new Map(), payments = new Map();
  const copy = structuredClone;
  const fixture = {
    orders, payments, creates: 0, paymentReads: 0, beforeReturn: null, rejectCreate: false, unavailable: false,
    async createOrder(request) {
      fixture.creates++;
      if (fixture.rejectCreate) { const error = new Error("Synthetic definitive rejection"); error.providerRejected = true; throw error; }
      const id = `order_${crypto.randomBytes(8).toString("hex")}`;
      const order = { ...copy(request), id, entity: "order", status: "created", amount_paid: 0, amount_due: request.amount };
      orders.set(id, order);
      await fixture.beforeReturn?.(order);
      return copy(order);
    },
    async fetchOrders({ receipt, count, skip }) { return fixture.collection([...orders.values()].filter(o => o.receipt === receipt).slice(skip, skip + count)); },
    async fetchOrder(id) { if (fixture.unavailable) throw new Error("Synthetic unavailable"); if (!orders.has(id)) throw new Error("Unknown synthetic order"); return copy(orders.get(id)); },
    async fetchOrderPayments(id) { if (fixture.unavailable) throw new Error("Synthetic unavailable"); return fixture.collection([...payments.values()].filter(p => p.order_id === id)); },
    async fetchPayment(id) { fixture.paymentReads++; if (!payments.has(id)) throw new Error("Unknown synthetic payment"); return copy(payments.get(id)); },
    collection(items) { return { entity: "collection", count: items.length, items: copy(items) }; },
    pay(orderId, status = "captured") {
      const order = orders.get(orderId); if (!order) throw new Error("Unknown synthetic order");
      const payment = { id: `pay_${crypto.randomBytes(8).toString("hex")}`, entity: "payment", order_id: orderId, amount: order.amount, currency: "INR", status, captured: status === "captured", amount_refunded: 0 };
      payments.set(payment.id, payment);
      Object.assign(order, status === "captured" ? { status: "paid", amount_paid: order.amount, amount_due: 0 } : { status: "attempted" });
      return copy(payment);
    },
    refund(paymentId, amount) { const p = payments.get(paymentId); p.amount_refunded = amount; p.status = amount === p.amount ? "refunded" : "captured"; return copy(p); },
    event(type, entity) {
      const kind = type.startsWith("refund.") ? "refund" : type.startsWith("order.") ? "order" : "payment";
      return { entity: "event", event: type, created_at: Math.floor(Date.now() / 1000), payload: { [kind]: { entity: copy(entity) } } };
    },
  };
  return fixture;
}
