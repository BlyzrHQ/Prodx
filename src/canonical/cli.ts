#!/usr/bin/env node
import "dotenv/config";
import {
  buildCollectionsOnce,
  getStatusSnapshot,
  ingestProducts,
  isTriggerConfigured,
  processPendingProducts,
  regenerateGuide,
  reviewSyncedProducts,
  syncStoreContextFromShopify,
  syncShopifyCatalog,
  triggerTask,
} from "./services/pipeline.js";
import { convexQuery } from "./services/convex.js";

const [, , command, ...args] = process.argv;

async function main() {
  switch (command) {
    case "sync":
      return handleSync(args[0]);
    case "review":
      return handleReview();
    case "run":
      return handleRun(args[0]);
    case "collections":
      return handleCollections(args[0]);
    case "publish":
      return handlePublish();
    case "status":
      return handleStatus();
    case "guide":
      return handleGuide();
    case "add":
      return handleAdd(args);
    default:
      console.log("Usage: npx tsx src/cli.ts <command>");
      console.log("Commands: sync, sync context, review, run pipeline, collections build, publish, status, guide, add");
  }
}

async function handleSync(subcommand?: string) {
  if (subcommand === "context") {
    const result = await syncStoreContextFromShopify();
    console.log(
      "Synced store context: " +
        result.productTypes +
        " product types, " +
        result.tags +
        " tags, " +
        result.vendors +
        " vendors, " +
        result.metafieldOptions +
        " metafield definitions, " +
        result.metaobjectOptions +
        " metaobject option groups."
    );
    return;
  }

  if (isTriggerConfigured()) {
    await triggerTask("shopify-sync", {});
    console.log("Dispatched Shopify catalog sync to Trigger.dev.");
    return;
  }

  const result = await syncShopifyCatalog();
  console.log("Synced " + result.productsSynced + " products and " + result.collectionsSynced + " collections.");
}

async function handleReview() {
  const result = await reviewSyncedProducts();
  console.log("Marked " + result.marked + " synced products for review.");
}

async function handleRun(subcommand: string | undefined) {
  if (subcommand !== "pipeline") {
    console.log("Usage: npx tsx src/cli.ts run pipeline");
    return;
  }

  const pending = await convexQuery<any[]>("products:getPendingPipeline", { limit: 100 });
  if (pending.length === 0) {
    console.log("No products are waiting for the pipeline.");
    return;
  }

  if (isTriggerConfigured()) {
    for (const product of pending) {
      await triggerTask("product-pipeline", { productId: product._id });
    }
    console.log("Dispatched " + pending.length + " products to Trigger.dev.");
    return;
  }

  const result = await processPendingProducts();
  console.log("Processed " + result.processed + " products locally.");
}

async function handleCollections(subcommand: string | undefined) {
  if (subcommand !== "build") {
    console.log("Usage: npx tsx src/cli.ts collections build");
    return;
  }

  if (isTriggerConfigured()) {
    await triggerTask("build-collections", {});
    console.log("Dispatched collection build to Trigger.dev.");
    return;
  }

  const result = await buildCollectionsOnce();
  console.log("Created " + result.created + " collection proposal(s).");
}

async function handlePublish() {
  if (isTriggerConfigured()) {
    await triggerTask("product-publisher", {});
    console.log("Dispatched product publish task to Trigger.dev.");
    return;
  }

  const approved = await convexQuery<any[]>("products:getApprovedForPublish", {});
  console.log("Approved products ready for publish: " + approved.length);
}

async function handleStatus() {
  const status = await getStatusSnapshot();
  console.log("Products:");
  console.log(JSON.stringify(status.products, null, 2));
  console.log("Collections:");
  console.log(JSON.stringify(status.collections, null, 2));
}

async function handleGuide() {
  await regenerateGuide();
  console.log("Catalog guide regenerated and stored locally + in storeContext.");
}

async function handleAdd(args: string[]) {
  const input: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    const value = args[index + 1];
    if (key?.startsWith("--") && value) {
      input[key.slice(2)] = value;
      index++;
    }
  }

  if (isTriggerConfigured()) {
    await triggerTask("product-pipeline", {
      input: {
        fileUrl: input.file,
        fileName: input.file ? input.file.split(/[\\/]/).pop() : undefined,
        textInput: input.text,
        imageUrl: input["image-url"],
      },
    });
    console.log("Dispatched product intake + pipeline to Trigger.dev.");
    return;
  }

  const result = await ingestProducts({
    fileUrl: input.file,
    fileName: input.file ? input.file.split(/[\\/]/).pop() : undefined,
    textInput: input.text,
    imageUrl: input["image-url"],
  });

  console.log(
    "Added " + result.added +
      ", skipped " + result.skipped +
      ", variants " + result.variants +
      ", uncertain " + result.uncertain + "."
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
