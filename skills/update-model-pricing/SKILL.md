---
name: update-model-pricing
description: Look up a model's current official API price and record it in soot, with the source URL and the date checked. Use when a new provider or API key is added to soot, when soot uses a model id it has no price for (soot warns "N model(s) have no price"), or when a recorded price is old or about to change.
---

# Update model pricing

soot computes the cost of every task and of the planning call as reported tokens × list
price. A model with no price shows **"price not set"**, and totals that include it show
**"partial"**. This prompt adds the missing prices. It never guesses one.

## When to run it

- A provider or API key was just added to soot (a new entry in the models file).
- soot used or listed a model id it has no price for. `soot run`, `soot config` and
  `soot models` print: `N model(s) have no price (...). Run the update-model-pricing prompt`.
- A price in the catalog is dated (it has `effectiveUntil`) and the date is near, or a price
  is more than about 90 days old.

## Where prices live

Pick the right target first:

1. **soot's shipped catalog**, `packages/model-registry/src/price-catalog.ts` (`PRICE_CATALOG`).
   Only for a vendor's own API (OpenAI, Anthropic, Google Gemini API, xAI, DeepSeek,
   Mistral, ...), matched on the API host and the exact model id. Edit it when you are
   working on the soot repository.
2. **The user's models file** (the `models` file named in `soot.config.json`, often
   `models.json`): a `pricing` object on the model. Use this for proxies, resellers, private
   contracts, local runtimes, or when you are working in a user's project rather than in
   soot itself. A configured price always wins over the catalog.

## Steps

1. List what is missing: run `soot models` (or `soot config --json` and read
   `pricing.unpriced`). Note each `provider/modelId` and the provider's `baseURL`, if any.
2. For each model, open the vendor's **official** pricing page (the vendor's own docs or
   pricing site, not a blog, aggregator, reseller, or search-result summary). Known pages:
   - OpenAI: https://platform.openai.com/docs/pricing
   - Anthropic: https://docs.anthropic.com/en/docs/about-claude/pricing
   - Google Gemini API: https://ai.google.dev/gemini-api/docs/pricing
   - xAI: https://docs.x.ai/docs/models
   - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
   - Mistral: https://docs.mistral.ai/inference/pricing
3. Confirm the exact model id on the vendor's model page. soot matches ids verbatim.
4. Read the **standard** (not batch, flex, priority, or fast) per-million-token prices:
   - input, output;
   - cached input (cache read), if listed;
   - cache write, if listed (Anthropic: the 5-minute write; OpenAI: the 30-minute write);
   - a **long-context tier**, if the page bills long prompts at a higher rate. Record it as
     `longContext: { aboveInputTokens, inputPerMTokUsd, outputPerMTokUsd, cacheReadPerMTokUsd,
cacheWritePerMTokUsd }`. `aboveInputTokens` is the largest prompt size that still gets the
     base rate (">272K" is `272000`; "200k or more" is `199999`);
   - **dated changes** ("$2 through November 30, $4 from December 1"): in the catalog, add one
     entry per period with `effectiveUntil` / `effectiveFrom` (inclusive `YYYY-MM-DD`). In a
     user's models file, record today's price and put the change in `notes`;
   - anything soot does not model (time-of-day discounts, regional uplifts, storage fees):
     use the higher standard rate and say so in `notes`.
5. Write the entry:
   - `source`: the official pricing page URL you read.
   - `asOf`: today's date, `YYYY-MM-DD`.
   - Catalog only: add the page to `OFFICIAL_SOURCES` in `price-catalog.test.ts` if it is new.
6. Verify: `pnpm run build && pnpm test` in the soot repo (the catalog test checks sources,
   dates and overlaps), or `soot models` in a user project. The warning should be gone for the
   models you priced.
7. Report a table: model id, input, output, cached input, long-context tier, source URL, date.
   List every model you could **not** price, and why.

## Rules

- **Never guess.** If the official page does not list the model, or the number is ambiguous,
  leave it unpriced. "price not set" is correct; a wrong number is not.
- Never copy a price from memory, a third-party site, or another model of the same family.
- Do not add models to the catalog. It holds prices for model ids users configure; it is not
  a model list, and it never sets a default model or a `decomposer.model`.
- Do not change a price the user configured in their models file unless they asked.
- **Never touch secrets.** Do not read, print, copy, or test API key values. Provider entries
  name the variable (`apiKeyEnv`); that is all you need. Do not call a provider API to
  "check" a price; read the public pricing page.
- soot itself never fetches prices over the network. This prompt is how prices get updated.
