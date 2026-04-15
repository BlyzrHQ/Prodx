import { task } from "@trigger.dev/sdk/v3";
import { syncStoreContextFromShopify } from "../services/pipeline.js";

export const storeContextSync = task({
  id: "store-context-sync",
  run: async () => {
    return syncStoreContextFromShopify();
  },
});
