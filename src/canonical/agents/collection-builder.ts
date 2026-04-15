import { callLlm } from "../services/llm.js";

export async function runCollectionBuilderAgent(input: {
  candidate: { source: string; value: string; count: number };
  guide: Record<string, unknown>;
}): Promise<{
  title: string;
  handle: string;
  descriptionHtml: string;
  seoTitle: string;
  seoDescription: string;
  ruleType: string;
  ruleValue: string;
  rationale: string;
  productCount: number;
}> {
  const { candidate, guide } = input;
  const guideContext = {
    merchandising_rules: (guide as any)?.merchandising_rules ?? {},
    taxonomy: (guide as any)?.taxonomy ?? {},
    seo_discovery_rules: (guide as any)?.seo_discovery_rules ?? {},
    collection_logic: (guide as any)?.collection_logic ?? {},
  };

  return callLlm({
    systemPrompt: `You are a senior Shopify collection strategist.

Your job is to turn one catalog summary candidate into a clear, customer-friendly, publication-ready collection proposal.

## YOUR MINDSET
- Think like a merchandiser, not a database.
- The collection title should feel natural to a shopper.
- The description should explain what belongs in the collection and why it is useful.
- SEO should be clean, descriptive, and aligned with the title.
- Avoid awkward internal terminology unless the guide clearly treats it as customer-facing.

## HARD RULES
- Only build collections that represent a coherent browse group.
- Respect the guide's merchandising, taxonomy, and SEO rules.
- Do not create duplicate or near-duplicate collection concepts.
- Product count must stay aligned with the candidate count you are given.
- The handle must be lowercase, hyphenated, and based on the finalized title.
- The descriptionHtml must be clean HTML, not plain text wrapped in a tag.
- The rationale should briefly explain why this collection belongs in the catalog.

## CANDIDATE LOGIC
- source tells you what kind of catalog signal triggered the candidate.
- value is the candidate value.
- count is how many products currently match it.

## GUIDE SLICES
${JSON.stringify(guideContext, null, 2)}

## OUTPUT
Return strict JSON only with:
- title
- handle
- descriptionHtml
- seoTitle
- seoDescription
- ruleType
- ruleValue
- rationale
- productCount`,
    userPrompt:
      "Candidate:\n" +
      JSON.stringify(candidate, null, 2) +
      "\n\nBuild the strongest collection proposal for this candidate.",
    schema: {
      name: "collection_proposal",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          handle: { type: "string" },
          descriptionHtml: { type: "string" },
          seoTitle: { type: "string" },
          seoDescription: { type: "string" },
          ruleType: { type: "string" },
          ruleValue: { type: "string" },
          rationale: { type: "string" },
          productCount: { type: "number" },
        },
        required: [
          "title",
          "handle",
          "descriptionHtml",
          "seoTitle",
          "seoDescription",
          "ruleType",
          "ruleValue",
          "rationale",
          "productCount",
        ],
      },
    },
  });
}
