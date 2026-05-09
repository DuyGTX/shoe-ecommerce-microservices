# Enterprise Upgrade Roadmap (2-3 Weeks)

## Objective
Upgrade the current microservices platform to an enterprise-ready baseline with stronger code quality, observability, security, and distributed transaction reliability.

## Success Criteria (End of Week 3)
- CI pipeline is stable with test coverage and quality gates across core services.
- End-to-end request traces are visible from API Gateway to downstream services and async event flow.
- Internal service communication is authenticated with rotating internal tokens.
- Order and payment flows are protected against duplicate processing.
- Event publication is resilient to broker failures via Outbox/Inbox-based eventual consistency.
- Inter-service calls degrade gracefully with standardized retry/backoff and circuit breaker controls.

---

## Week 1 - Foundation Hardening & Code Quality
**Effort:** Medium

| Task | Short Description | Priority | Outcome (Measurable) |
|---|---|---|---|
| Refactor API Gateway (`server.js` decomposition) | Split the current gateway entrypoint into domain-oriented modules (auth, user, cart, order, product, payment), plus shared middleware and config layers. | High | `api-gateway/server.js` becomes a thin bootstrap file; at least 80% routing logic moved into modular files; no behavior regression in smoke test. |
| Testing strategy for missing services | Add unit and integration tests for `user-service`, `product-service`, and `payment-service` (happy path + validation + auth failures). | High | Each service has runnable `test` script; minimum smoke coverage for critical endpoints; CI executes all service test suites before compose smoke test. |
| Standardized error contract | Introduce a shared error response format: `{ code, message, requestId, details?, timestamp }` and apply consistently in all services. | High | 100% error responses from gateway/services follow one schema; logs include matching `requestId`; OpenAPI specs updated for error models. |
| Shared middleware baselines | Standardize request logging, requestId injection, validation failure handling, and auth error mapping across services. | Medium | Common middleware pattern documented and implemented in all services; duplicated error-handling logic reduced by at least 50%. |

**Week 1 Exit Gate**
- All target services pass tests in CI.
- Gateway refactor merged with no endpoint breakage.
- Error schema consistency validated via integration tests.

---

## Week 2 - Full Observability & Internal Security
**Effort:** Medium-High

| Task | Short Description | Priority | Outcome (Measurable) |
|---|---|---|---|
| Distributed tracing with OpenTelemetry | Instrument API Gateway and all services for trace/span propagation, including HTTP hops, RabbitMQ publish/consume, and database operations. | High | At least 90% of requests include end-to-end trace IDs; traces visible across gateway -> service -> broker -> DB path. |
| API versioning (`/api/v1`) | Introduce explicit versioned routes and maintain backward compatibility for current consumers. | High | All public endpoints are exposed under `/api/v1`; backward compatibility mapping documented; zero breaking change for existing smoke tests. |
| Service-to-service auth with token rotation | Harden internal calls using scoped internal tokens with rotation policy and rollout strategy. | High | Internal endpoints reject missing/invalid tokens; token rotation procedure tested; no service downtime during rotation drill. |
| Observability SLO dashboards and alerts | Define baseline SLO metrics (latency, error rate, saturation) and alerts in Grafana/Prometheus for gateway + core services. | Medium | Dashboards cover p50/p95 latency, 5xx rates, queue lag, and DB health; actionable alerts configured for critical thresholds. |

**Week 2 Exit Gate**
- Tracing confirms cross-service request visibility.
- Versioned APIs are active and documented.
- Internal token auth and rotation runbook is validated.

---

## Week 3 - Distributed Transaction Reliability
**Effort:** High-Very High

| Task | Short Description | Priority | Outcome (Measurable) |
|---|---|---|---|
| Idempotency for order/payment APIs | Add idempotency key handling for order creation and payment operations to prevent duplicate side effects during retries/timeouts. | High | Duplicate requests with same key return same logical result; double-charge and duplicate order rate reduced to near zero in chaos/retry tests. |
| Transactional Outbox + Inbox pattern | Persist domain events in Outbox within the same DB transaction, then relay to RabbitMQ; consume with Inbox deduplication. | High | Zero event loss in broker outage simulation; at-least-once delivery with consumer-side dedupe verified by replay tests. |
| Resilience policy baseline | Implement standardized retry + exponential backoff + jitter + circuit breaker for all inter-service calls and selected broker interactions. | High | Inter-service error cascades reduced; controlled failure behavior observed in load/fault tests; breaker metrics exported to monitoring stack. |
| Failure drills and recovery runbooks | Run failure scenarios (broker down, DB slow, service timeout) and document recovery steps. | Medium | Runbooks published; mean recovery time improved and measurable in controlled drills. |

**Week 3 Exit Gate**
- Idempotency and outbox reliability validated with failure simulations.
- Circuit breaker and retry policy active across critical service dependencies.
- Recovery runbooks approved and linked in operational docs.

---

## Delivery Plan by Priority

### High Priority (Must Ship)
1. Gateway modular refactor.
2. Tests for user/product/payment services.
3. Unified error contract with requestId.
4. OpenTelemetry end-to-end traces.
5. API versioning (`/api/v1`).
6. Internal token auth + rotation.
7. Idempotency for order/payment.
8. Transactional Outbox/Inbox.
9. Retry/backoff/circuit breaker baseline.

### Medium Priority (Should Ship)
1. Shared middleware standardization.
2. SLO dashboards and alerting baseline.
3. Failure drills and recovery runbooks.

---

## Risk & Dependency Notes
- Outbox/Inbox requires schema design and migration sequencing before full rollout.
- Token rotation requires strict clock sync and staged deployment across services.
- Tracing rollout should be incremental to avoid overhead spikes in production.
- Idempotency must define key scope (user, operation type, TTL) before implementation.

## Governance and Tracking
- Weekly demo: architecture delta + measurable outcomes.
- Daily status: blockers, risk updates, and quality metrics.
- Definition of done per task: code merged, tests passing, docs/runbook updated, and observability signal verified.