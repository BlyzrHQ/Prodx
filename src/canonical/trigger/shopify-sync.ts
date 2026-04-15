import { task } from "@trigger.dev/sdk/v3";
import { syncShopifyCatalog } from "../services/pipeline.js";

export const shopifySync = task({
  id: "shopify-sync",
  run: async () => {
    return syncShopifyCatalog();
  },
});
