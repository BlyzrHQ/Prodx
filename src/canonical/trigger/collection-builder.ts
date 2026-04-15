import { task, schedules } from "@trigger.dev/sdk/v3";
import { buildCollectionsOnce } from "../services/pipeline.js";

export const buildCollections = task({
  id: "build-collections",
  run: async () => {
    return buildCollectionsOnce();
  },
});

export const nightlyCollectionBuilder = schedules.task({
  id: "nightly-collection-builder",
  cron: { pattern: "0 2 * * *", timezone: "Asia/Riyadh" },
  run: async () => {
    return buildCollectionsOnce();
  },
});
