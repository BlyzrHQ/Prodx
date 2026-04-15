import { task, schedules } from "@trigger.dev/sdk/v3";
import { regenerateGuide } from "../services/pipeline.js";

export const regenerateCatalogGuide = task({
  id: "regenerate-catalog-guide",
  run: async () => {
    await regenerateGuide();
    return { regenerated: true };
  },
});

export const weeklyGuideRefresh = schedules.task({
  id: "weekly-guide-refresh",
  cron: { pattern: "0 3 * * 0", timezone: "Asia/Riyadh" },
  run: async () => {
    await regenerateGuide();
    return { regenerated: true };
  },
});
