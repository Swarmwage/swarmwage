// Swarmwage MCP — Agentic Market external x402 catalog client
// License: MIT
//
// Read-only discovery for third-party x402 endpoints. These are NOT
// Swarmwage-verified sellers: callers can pay them via call_x402_service,
// but they do not carry Swarmwage receipts, verification, or reputation.

import type { UsdcAmount } from "@swarmwage/agent-sdk";

export const AGENTIC_MARKET_API_URL = "https://api.agentic.market";

export interface AgenticMarketSearchRequest {
  query?: string;
  category?: string;
  max_price_usdc?: UsdcAmount;
  limit?: number;
  include_dynamic_pricing?: boolean;
}

export interface ExternalX402Endpoint {
  source: "agentic.market";
  service_id: string;
  service_name: string;
  service_description: string;
  category: string;
  domain: string;
  provider_url: string;
  integration_type: string;
  endpoint: {
    url: string;
    method: string;
    description: string;
    pricing: {
      amount_usdc: UsdcAmount;
      scheme: string;
      network: string;
      currency: string;
      max_amount_usdc?: UsdcAmount;
      min_amount_usdc?: UsdcAmount;
    };
    parameters: ExternalX402Parameter[];
    quality: {
      last_30d_calls: number;
      last_30d_unique_payers: number;
    } | null;
  };
  call_hint: {
    tool: "call_x402_service";
    url: string;
    method: string;
    max_price_usdc: UsdcAmount;
    source: "agentic.market";
    service_id: string;
    service_name: string;
    endpoint_description: string;
    category: string;
    pricing_scheme: string;
  };
}

export interface ExternalX402Parameter {
  group: string;
  name: string;
  type: string;
  description: string;
  example?: unknown;
  required: boolean;
}

export interface AgenticMarketSearchResponse {
  source: "agentic.market";
  query: string;
  total_services_reported: number;
  scanned_services: number;
  endpoints: ExternalX402Endpoint[];
  filters: {
    network: "Base";
    currency: "USDC";
    pricing_scheme: "exact" | "exact+dynamic";
    max_price_usdc?: UsdcAmount;
  };
  note: string;
}

interface AgenticMarketServicePage {
  services: AgenticMarketService[];
  total?: number;
  limit?: number;
  offset?: number;
}

interface AgenticMarketService {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  domain?: unknown;
  providerUrl?: unknown;
  category?: unknown;
  networks?: unknown;
  endpoints?: unknown;
  integrationType?: unknown;
}

interface AgenticMarketEndpoint {
  url?: unknown;
  method?: unknown;
  description?: unknown;
  pricing?: unknown;
  parameters?: unknown;
  quality?: unknown;
}

interface AgenticMarketPricing {
  amount?: unknown;
  currency?: unknown;
  network?: unknown;
  scheme?: unknown;
  maxAmount?: unknown;
  minAmount?: unknown;
}

interface AgenticMarketQuality {
  l30DaysTotalCalls?: unknown;
  l30DaysUniquePayers?: unknown;
}

interface AgenticMarketParameter {
  group?: unknown;
  name?: unknown;
  type?: unknown;
  description?: unknown;
  example?: unknown;
  required?: unknown;
}

export async function searchAgenticMarketServices(
  req: AgenticMarketSearchRequest,
  opts: { fetchImpl?: typeof fetch; apiUrl?: string } = {},
): Promise<AgenticMarketSearchResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const apiUrl = opts.apiUrl ?? AGENTIC_MARKET_API_URL;
  const limit = clampLimit(req.limit);
  const query = (req.query ?? "").trim();
  const upstreamLimit = Math.max(limit * 3, 25);
  const url = new URL(
    query.length > 0
      ? `${apiUrl}/v1/services/search`
      : `${apiUrl}/v1/services`,
  );
  if (query.length > 0) url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.min(upstreamLimit, 100)));
  url.searchParams.set("offset", "0");

  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(
      `agentic.market search failed: ${res.status} ${res.statusText}`,
    );
  }

  const page = (await res.json()) as AgenticMarketServicePage;
  const services = Array.isArray(page.services) ? page.services : [];
  const endpoints = normalizeEndpoints(services, req)
    .sort(compareEndpointRank)
    .slice(0, limit);

  return {
    source: "agentic.market",
    query,
    total_services_reported: Number(page.total ?? services.length),
    scanned_services: services.length,
    endpoints,
    filters: {
      network: "Base",
      currency: "USDC",
      pricing_scheme: req.include_dynamic_pricing ? "exact+dynamic" : "exact",
      max_price_usdc: req.max_price_usdc,
    },
    note:
      "These are external x402 endpoints from Agentic Market, not Swarmwage-verified sellers. Use call_x402_service with the returned call_hint to pay/call one; no Swarmwage receipt, verifier, or rating is attached.",
  };
}

function normalizeEndpoints(
  services: AgenticMarketService[],
  req: AgenticMarketSearchRequest,
): ExternalX402Endpoint[] {
  const out: ExternalX402Endpoint[] = [];
  const seen = new Set<string>();
  const category = (req.category ?? "").trim().toLowerCase();
  const maxPrice = parsePrice(req.max_price_usdc);

  for (const svc of services) {
    const svcCategory = text(svc.category);
    if (category && svcCategory.toLowerCase() !== category) continue;

    const endpoints = Array.isArray(svc.endpoints)
      ? (svc.endpoints as AgenticMarketEndpoint[])
      : [];
    for (const endpoint of endpoints) {
      const pricing = objectOrNull<AgenticMarketPricing>(endpoint.pricing);
      if (!pricing) continue;

      const network = text(pricing.network);
      const currency = text(pricing.currency);
      const scheme = text(pricing.scheme);
      const amount = text(pricing.amount);
      const price = parsePrice(amount);
      const url = text(endpoint.url);
      if (!url || price === null || price <= 0) continue;
      if (!isBaseNetwork(network)) continue;
      if (currency.toUpperCase() !== "USDC") continue;
      if (!req.include_dynamic_pricing && scheme !== "exact") continue;
      if (req.include_dynamic_pricing && scheme !== "exact" && scheme !== "upto") {
        continue;
      }
      if (maxPrice !== null && price > maxPrice) continue;

      const method = text(endpoint.method).toUpperCase() || "GET";
      const key = `${method} ${url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const quality = objectOrNull<AgenticMarketQuality>(endpoint.quality);
      const maxAmount = text(pricing.maxAmount);
      const minAmount = text(pricing.minAmount);
      const serviceId = text(svc.id);
      const serviceName = text(svc.name) || text(svc.domain);
      const endpointDescription = text(endpoint.description);
      out.push({
        source: "agentic.market",
        service_id: serviceId,
        service_name: serviceName,
        service_description: text(svc.description),
        category: svcCategory,
        domain: text(svc.domain),
        provider_url: text(svc.providerUrl),
        integration_type: text(svc.integrationType),
        endpoint: {
          url,
          method,
          description: text(endpoint.description),
          pricing: {
            amount_usdc: amount,
            scheme,
            network,
            currency,
            max_amount_usdc: maxAmount || undefined,
            min_amount_usdc: minAmount || undefined,
          },
          parameters: normalizeParameters(endpoint.parameters),
          quality: quality
            ? {
                last_30d_calls: integer(quality.l30DaysTotalCalls),
                last_30d_unique_payers: integer(quality.l30DaysUniquePayers),
              }
            : null,
        },
        call_hint: {
          tool: "call_x402_service",
          url,
          method,
          max_price_usdc: maxAmount || amount,
          source: "agentic.market",
          service_id: serviceId,
          service_name: serviceName,
          endpoint_description: endpointDescription,
          category: svcCategory,
          pricing_scheme: scheme,
        },
      });
    }
  }
  return out;
}

function normalizeParameters(input: unknown): ExternalX402Parameter[] {
  if (!Array.isArray(input)) return [];
  return (input as AgenticMarketParameter[]).map((param) => ({
    group: text(param.group),
    name: text(param.name),
    type: text(param.type),
    description: text(param.description),
    example: param.example,
    required: Boolean(param.required),
  }));
}

function compareEndpointRank(a: ExternalX402Endpoint, b: ExternalX402Endpoint): number {
  const aq = a.endpoint.quality;
  const bq = b.endpoint.quality;
  const calls =
    (bq?.last_30d_calls ?? 0) - (aq?.last_30d_calls ?? 0);
  if (calls !== 0) return calls;
  const payers =
    (bq?.last_30d_unique_payers ?? 0) -
    (aq?.last_30d_unique_payers ?? 0);
  if (payers !== 0) return payers;
  return (
    Number(a.endpoint.pricing.amount_usdc) -
    Number(b.endpoint.pricing.amount_usdc)
  );
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.max(1, Math.min(Math.trunc(limit ?? 10), 25));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function parsePrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isBaseNetwork(network: string): boolean {
  const normalized = network.toLowerCase();
  return normalized === "base" || normalized === "eip155:8453";
}

function objectOrNull<T extends object>(value: unknown): T | null {
  return value && typeof value === "object" ? (value as T) : null;
}
