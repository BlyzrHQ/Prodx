import { callLlm } from "../services/llm.js";

export async function runCollectionEvaluatorAgent(input: {
  proposal: {
    title: string;
    handle: string;
    descriptionHtml: string;
    seoTitle: string;
    seoDescription: string;
    productCount: number;
  };
  existingCollections: Array<{ title: string; handle: string }>;
}): Promise<{ decision: "APPROVE" | "REJECT"; reasoning: string }> {
  const { proposal, existingCollections } = input;

  const duplicate = existingCollections.some(
    (collection) =>
      collection.handle.toLowerCase() === proposal.handle.toLowerCase() ||
      collection.title.toLowerCase() === proposal.title.toLowerCase()
  );

  if (proposal.productCount < 5 || duplicate) {
    return {
      decision: "REJECT",
      reasoning: duplicate
        ? "Duplicate collection title or handle."
        : "Collection candidate has fewer than 5 products.",
    };
  }

  return callLlm({
    systemPrompt: `You are a senior Shopify collection QA reviewer.

Your job is to decide whether a generated collection is strong enough to save for review or approval.

## YOUR MINDSET
- A shopper should understand the collection immediately.
- The title should feel natural, useful, and browseable.
- The description should clearly explain what belongs in the collection.
- SEO should be clean and publication-ready.

## HARD RULES
- Reject vague, awkward, or low-value collection concepts.
- Reject raw internal labels that do not read well to shoppers.
- Reject weak or generic descriptions that do not explain the collection clearly.
- Reject titles or handles that are too close to existing collections.
- Reject collections that do not feel justified by the stated product count.
- Prefer fewer stronger collections over noisy collection sprawl.

## OUTPUT
Return strict JSON only with:
- decision: APPROVE or REJECT
- reasoning: a concise explanation grounded in shopper clarity, merchandising value, title quality, description quality, SEO quality, and candidate strength`,
    userPrompt:
      "Proposal:\n" +
      JSON.stringify(proposal, null, 2) +
      "\n\nExisting collections:\n" +
      JSON.stringify(existingCollections, null, 2) +
      "\n\nReview this collection proposal now.",
    schema: {
      name: "collection_review",
      schema: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["APPROVE", "REJECT"] },
          reasoning: { type: "string" },
        },
        required: ["decision", "reasoning"],
      },
    },
  });
}
