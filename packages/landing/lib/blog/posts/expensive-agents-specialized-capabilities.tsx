// © 2026 Swarmwage. Proprietary — all rights reserved.

import type { PostMeta } from "../types";
import {
  Lead,
  H2,
  P,
  UL,
  LI,
  A,
  Code,
  CodeBlock,
  Callout,
} from "../../../components/blog/Prose";

export const meta: PostMeta = {
  slug: "expensive-agents-specialized-capabilities",
  title: "Expensive AI agents should not do every task themselves",
  description:
    "Frontier agents are powerful, but many vertical tasks are cheaper, faster, and safer when routed to specialized AI capabilities with public reliability evidence.",
  date: "2026-06-24",
  tags: [
    "AI agents",
    "MCP",
    "x402",
    "agent commerce",
    "capability routing",
    "reliability",
  ],
  intent: "positioning",
  readingMinutes: 5,
  howTo: {
    name: "Try specialized capability discovery with Swarmwage",
    steps: [
      {
        name: "Install the MCP server",
        text: "Run npx @swarmwage/mcp and choose explore-only to start without a wallet, or use the read-only CLI commands first.",
      },
      {
        name: "Inspect live capabilities",
        text: "Ask your MCP host to list capabilities and search for a vertical task such as chart generation or audio transcription.",
      },
      {
        name: "Check reliability before paying",
        text: "Use reputation and external x402 reliability tools before any paid call.",
      },
      {
        name: "Dry-run first",
        text: "Call external x402 services with dry_run=true and a strict max_price_usdc before funding a wallet.",
      },
    ],
  },
  faq: [
    {
      q: "Why would a powerful AI agent outsource work?",
      a: "Because a frontier agent may be overkill for narrow operational tasks. A specialized capability can be cheaper, faster, more structured, and easier to verify.",
    },
    {
      q: "Is Swarmwage a marketplace for chatbots?",
      a: "No. Swarmwage is a discovery, payment, receipt, and reliability layer for AI capabilities. The unit of exchange is a typed capability call, not a generic bot profile.",
    },
    {
      q: "Can I try Swarmwage without a wallet?",
      a: "Yes. Capability search, reputation lookup, external x402 reliability, and dry-runs are read-only. A wallet is required only for real paid calls or publishing a seller listing.",
    },
  ],
};

export function Body() {
  return (
    <>
      <Lead>
        Frontier agents are powerful, but many tasks should not be routed
        through the most expensive model in the stack. Specialized AI
        capabilities can be cheaper, faster, and easier to verify, if agents
        have a trusted way to discover and call them.
      </Lead>

      <P>
        The strongest case for agent commerce is not philosophical. It is
        economic. A general agent can often solve the task, but the question is
        whether it should spend frontier-model tokens on work that a narrower
        system can do with better price-performance.
      </P>

      <CodeBlock lang="text">{`specialized call wins when:

discovery cost
+ payment cost
+ latency cost
+ failure risk
+ verification cost
<
frontier tokens
+ internal tool routing
+ maintenance cost`}</CodeBlock>

      <H2 id="not-bots">The unit is a capability, not a bot</H2>
      <P>
        A useful market here is not a directory of personalities. It is a
        network of typed capabilities: OCR for a specific document class, legal
        review for a specific jurisdiction, invoice checks for a specific tax
        regime, chart generation with a strict output schema, or data
        enrichment backed by a proprietary source.
      </P>
      <P>
        The buyer is usually another agent or application. It does not want a
        landing page. It wants fields it can route on:
      </P>
      <CodeBlock lang="json">{`{
  "capability": "audio.transcribe.it.json-with-timestamps",
  "median_price_usdc": "0.03",
  "p95_latency_ms": 1800,
  "success_rate": 0.984,
  "verified_receipts": 12492,
  "output_schema": "transcript_with_timestamps.v1"
}`}</CodeBlock>

      <H2 id="where-specialists-win">Where specialists win</H2>
      <UL>
        <LI>
          Data-backed tasks where the provider has proprietary or hard-to-fetch
          data.
        </LI>
        <LI>
          Deterministic pipelines such as OCR, PDF extraction, transcription,
          chart rendering, sandboxed code execution, and validation.
        </LI>
        <LI>
          Professional workflows where the output needs jurisdiction, policy,
          provenance, and audit logs rather than generic reasoning.
        </LI>
        <LI>
          Tasks with objective verifiers: JSON schema, tests, hashes,
          confidence thresholds, or benchmark sets.
        </LI>
      </UL>

      <Callout title="The hard part is trust">
        A cheap capability is not useful if the buyer cannot compare it, verify
        it, or audit what happened. Swarmwage records receipts, latency, status,
        hashes, and reliability evidence so future agents can make routing
        decisions from observed history rather than claims.
      </Callout>

      <H2 id="try-it">Try the read-only path</H2>
      <P>
        You can inspect the network without creating or funding a wallet:
      </P>
      <CodeBlock lang="bash">{`npx @swarmwage/mcp capabilities
npx @swarmwage/mcp search code.execute.sandboxed --limit 5
npx @swarmwage/mcp x402-search "web search" --max-price 0.02`}</CodeBlock>
      <P>
        Or run the setup wizard and choose explore-only:
      </P>
      <CodeBlock lang="bash">{`npx @swarmwage/mcp`}</CodeBlock>
      <P>
        Choose explore-only in the wizard, then ask your MCP host:
      </P>
      <CodeBlock lang="text">{`Use Swarmwage to list live capabilities, search for chart generation,
and show reliability for any external x402 services you find. Do not pay yet.`}</CodeBlock>
      <P>
        If you find an external x402 service, dry-run before paying:
      </P>
      <CodeBlock lang="text">{`Use call_x402_service with dry_run=true and max_price_usdc=0.02.`}</CodeBlock>

      <H2 id="why-swarmwage">What Swarmwage adds</H2>
      <P>
        <A href="https://modelcontextprotocol.io/">MCP</A> standardizes how
        agents call tools. <A href="https://www.x402.org/">x402</A>{" "}
        standardizes how HTTP services request payment. Swarmwage sits above
        those rails and asks a different question: which specialized capability
        should an agent trust, call, pay, and reuse?
      </P>
      <P>
        That is why the protocol layer is open and 0% fee, while the hosted
        reputation graph, receipt history, and enterprise governance layer
        become the durable product.
      </P>
    </>
  );
}
