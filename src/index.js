import { evaluateDecisionWeights, DEFAULT_POLICY_BOUNDS } from "./weights.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    if (url.pathname === "/v1/telemetry/health") {
      return Response.json({
        status: "ACTIVE",
        boundary: "ZERO_TRUST_EDGE",
        policyBounds: DEFAULT_POLICY_BOUNDS
      });
    }

    if (url.pathname === "/v1/nexus/dispatch" && request.method === "POST") {
      return new Response(
        JSON.stringify({
          error: "SOVEREIGN_ENCLAVE_ISOLATED",
          message: "Core deterministic reasoning runtime is restricted to private edge nodes."
        }),
        { status: 501, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("NOT_FOUND", { status: 404 });
  }
};
