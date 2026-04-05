import { runMatchDecision } from "../modules/match.js";
import { deriveLessonsFromQa } from "../modules/learn.js";
import { runEnrichAgent } from "../agents/enrich-agent.js";
import { runImageAgent } from "../agents/image-agent.js";
import { runQaAgent } from "../agents/qa-agent.js";
import { decideSupervisorAction } from "../agents/supervisor-agent.js";
import { asLooseRecord } from "../agents/shared.js";
import { appendLearningRecords, loadLearningRecords, loadWorkflowMemory, saveWorkflowMemory, summarizeLearningRecords } from "../lib/learning.js";
import { buildGeneratedProduct, getProductKey } from "../lib/generated.js";
import type {
  LearningRecord,
  LooseRecord,
  ModuleResult,
  PolicyDocument,
  ProductRecord,
  QaRetryFeedback,
  RuntimeConfig,
  WorkflowMemory,
  WorkflowRunSummary
} from "../types.js";

export interface ExecutedModuleLike {
  job_id: string;
  run_dir: string;
  result: ModuleResult;
}

export interface PersistedOutputInfo {
  productPath: string;
  imageDirectory?: string;
  selectedImageUrl?: string;
  localImagePath?: string;
}

export interface AgenticWorkflowResult {
  currentRecord: ProductRecord;
  modules: WorkflowRunSummary["modules"];
  executions: ExecutedModuleLike[];
  productKey: string;
  sourceRecordId: string;
  imageDirectory: string;
  selectedImageUrl?: string;
  localImagePath?: string;
  memoryPath: string;
  skipSync: boolean;
}

function getMatchDecision(record: LooseRecord | null | undefined): string {
  const match = record?._catalog_match;
  if (!match || typeof match !== "object") return "";
  const decision = (match as LooseRecord).decision;
  return typeof decision === "string" ? decision.toUpperCase() : "";
}

function getMatchNeedsReview(record: LooseRecord | null | undefined): boolean {
  const match = record?._catalog_match;
  if (!match || typeof match !== "object") return false;
  return Boolean((match as LooseRecord).needs_review);
}

function shouldSkipAfterMatch(record: ProductRecord): boolean {
  const decision = getMatchDecision(record as LooseRecord);
  if (decision === "DUPLICATE") return true;
  return getMatchNeedsReview(record as LooseRecord);
}

function buildInitialRecord(record: ProductRecord, sourceRecordId: string): ProductRecord {
  return {
    ...record,
    source_record_id: sourceRecordId,
    _catalog_match_basis: {
      title: record.title ?? "",
      brand: record.brand ?? record.vendor ?? "",
      vendor: record.vendor ?? record.brand ?? "",
      handle: record.handle ?? "",
      sku: record.sku ?? "",
      barcode: record.barcode ?? "",
      size: record.size ?? record.option1 ?? "",
      type: record.type ?? record.option2 ?? "",
      option1: record.option1 ?? "",
      option2: record.option2 ?? "",
      option3: record.option3 ?? ""
    }
  };
}

function getAttemptCount(memory: WorkflowMemory, agentId: string): number {
  return memory.attempts.filter((item) => item.agent_id === agentId).length;
}

function buildRetryContext(record: ProductRecord, qaFeedback: QaRetryFeedback | undefined, learningRecords: LearningRecord[]): ProductRecord {
  return {
    ...record,
    _catalog_agent_context: {
      qa_feedback: qaFeedback ?? null,
      learning_notes: summarizeLearningRecords(learningRecords, 8)
    }
  };
}

function buildLearningRecords(productKey: string, findings: QaRetryFeedback, source: string): LearningRecord[] {
  const lessons = deriveLessonsFromQa([
    ...findings.fixable_findings,
    ...findings.hard_blockers,
    ...findings.review_blockers
  ]);
  return lessons.map((lesson, index) => ({
    id: `${productKey}-${source}-${Date.now()}-${index}`,
    created_at: new Date().toISOString(),
    source,
    lesson,
    product_key: productKey,
    metadata: { source_agent: source }
  }));
}

export async function runAgenticWorkflow(args: {
  root: string;
  record: ProductRecord;
  policy: PolicyDocument;
  runtimeConfig: RuntimeConfig;
  learningText: string;
  generatedImagesDir: string;
  matchCatalog?: LooseRecord[];
  matchCatalogSource?: string;
  executeModule: (moduleName: string, input: ProductRecord, handler: (jobId: string) => Promise<ModuleResult> | ModuleResult) => Promise<ExecutedModuleLike>;
  persistGeneratedOutputs: (product: ProductRecord, result: ModuleResult) => Promise<PersistedOutputInfo>;
  onProgress?: (message: string) => void;
}): Promise<AgenticWorkflowResult> {
  const sourceRecordId = String(args.record.id ?? args.record.product_id ?? args.record.sku ?? args.record.handle ?? args.record.title ?? "record");
  let currentRecord = buildInitialRecord(args.record, sourceRecordId);
  const productKey = getProductKey(currentRecord, sourceRecordId);
  let imageDirectory = args.generatedImagesDir;
  let selectedImageUrl: string | undefined;
  let localImagePath: string | undefined;
  const modules: WorkflowRunSummary["modules"] = [];
  const executions: ExecutedModuleLike[] = [];
  const persistentLearning = await loadLearningRecords(args.root);
  const memory = await loadWorkflowMemory(args.root, productKey, sourceRecordId);
  if (memory.learning_records.length === 0 && persistentLearning.length > 0) {
    memory.learning_records = persistentLearning.slice(-12);
  }

  if (args.matchCatalog) {
    args.onProgress?.("  -> catalogue-match ...");
    const matchRun = await args.executeModule("catalogue-match", currentRecord, async (jobId) => {
      const result = runMatchDecision({
        jobId,
        input: currentRecord,
        catalog: args.matchCatalog!,
        policy: args.policy,
        learningText: args.learningText
      });
      result.reasoning = [`Catalog source: ${args.matchCatalogSource ?? "generated"}`, ...(result.reasoning ?? [])];
      result.artifacts = { ...(result.artifacts ?? {}), catalog_source: args.matchCatalogSource ?? "generated" };
      return result;
    });
    executions.push(matchRun);
    const match = matchRun.result as unknown as LooseRecord;
    currentRecord = {
      ...currentRecord,
      _catalog_match: {
        decision: match.decision ?? null,
        confidence: match.confidence ?? null,
        needs_review: matchRun.result.needs_review,
        matched_product_id: match.matched_product_id ?? null,
        matched_variant_id: match.matched_variant_id ?? null,
        proposed_action: match.proposed_action ?? null,
        matched_product_handle: typeof (match.proposed_action as LooseRecord | undefined)?.product_handle === "string"
          ? (match.proposed_action as LooseRecord).product_handle
          : null,
        matched_product_title: typeof (match.proposed_action as LooseRecord | undefined)?.product_title === "string"
          ? (match.proposed_action as LooseRecord).product_title
          : null
      }
    };
    modules.push({ module: matchRun.result.module, job_id: matchRun.job_id, status: matchRun.result.status, needs_review: matchRun.result.needs_review });
    args.onProgress?.(`  -> catalogue-match ... ${matchRun.result.status}${matchRun.result.needs_review ? " (needs review)" : ""}`);
    if (shouldSkipAfterMatch(currentRecord)) {
      const memoryPath = await saveWorkflowMemory(args.root, memory);
      return {
        currentRecord: {
          ...currentRecord,
          _catalog_agent_run: {
            attempts: memory.attempts,
            supervisor_decisions: memory.supervisor_decisions,
            memory_path: memoryPath
          }
        },
        modules,
        executions,
        productKey,
        sourceRecordId,
        imageDirectory,
        memoryPath,
        skipSync: true
      };
    }
  }

  let nextAction: "initial" | "retry_enrich" | "retry_image" | "retry_both" = "initial";
  let lastQaFeedback: QaRetryFeedback | undefined;

  while (true) {
    const shouldRunEnrich = nextAction === "initial" || nextAction === "retry_enrich" || nextAction === "retry_both";
    const shouldRunImage = nextAction === "initial" || nextAction === "retry_image" || nextAction === "retry_both";

    if (shouldRunEnrich) {
      const retryReason = nextAction === "initial" ? undefined : memory.last_retry_reason;
      args.onProgress?.("  -> product-enricher ...");
      const enrichRun = await args.executeModule("product-enricher", buildRetryContext(currentRecord, lastQaFeedback, memory.learning_records), async (jobId) => {
        const execution = await runEnrichAgent({
          root: args.root,
          jobId,
          input: buildRetryContext(currentRecord, lastQaFeedback, memory.learning_records),
          policy: args.policy,
          attemptNumber: getAttemptCount(memory, "enrich-agent") + 1,
          retryReason,
          parentAttempt: getAttemptCount(memory, "enrich-agent") || null
        });
        return execution.result;
      });
      executions.push(enrichRun);
      currentRecord = buildGeneratedProduct(currentRecord, enrichRun.result) as ProductRecord;
      memory.attempts.push({
        agent_id: "enrich-agent",
        module: enrichRun.result.module,
        attempt_number: getAttemptCount(memory, "enrich-agent") + 1,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        retry_reason: retryReason,
        status: enrichRun.result.status,
        needs_review: enrichRun.result.needs_review,
        summary: enrichRun.result.reasoning[0] ?? enrichRun.result.status,
        provider_usage: (enrichRun.result.artifacts?.provider_usage as any) ?? null,
        input_snapshot: asLooseRecord(buildRetryContext(currentRecord, lastQaFeedback, memory.learning_records)),
        output_snapshot: { proposed_changes: enrichRun.result.proposed_changes, warnings: enrichRun.result.warnings, artifacts: enrichRun.result.artifacts }
      });
      if (nextAction !== "initial") memory.enrich_retries += 1;
      modules.push({ module: enrichRun.result.module, job_id: enrichRun.job_id, status: enrichRun.result.status, needs_review: enrichRun.result.needs_review });
      await args.persistGeneratedOutputs(currentRecord, enrichRun.result);
      args.onProgress?.(`  -> product-enricher ... ${enrichRun.result.status}${enrichRun.result.needs_review ? " (needs review)" : ""}`);
    }

    if (shouldRunImage) {
      const retryReason = nextAction === "initial" ? undefined : memory.last_retry_reason;
      args.onProgress?.("  -> image-optimizer ...");
      const imageRun = await args.executeModule("image-optimizer", buildRetryContext(currentRecord, lastQaFeedback, memory.learning_records), async (jobId) => {
        const execution = await runImageAgent({
          root: args.root,
          jobId,
          input: buildRetryContext(currentRecord, lastQaFeedback, memory.learning_records),
          policy: args.policy,
          runtimeConfig: args.runtimeConfig,
          attemptNumber: getAttemptCount(memory, "image-agent") + 1,
          retryReason,
          parentAttempt: getAttemptCount(memory, "image-agent") || null
        });
        return execution.result;
      });
      executions.push(imageRun);
      currentRecord = buildGeneratedProduct(currentRecord, imageRun.result) as ProductRecord;
      const persisted = await args.persistGeneratedOutputs(currentRecord, imageRun.result);
      imageDirectory = persisted.imageDirectory ?? imageDirectory;
      selectedImageUrl = persisted.selectedImageUrl ?? selectedImageUrl;
      localImagePath = persisted.localImagePath ?? localImagePath;
      memory.attempts.push({
        agent_id: "image-agent",
        module: imageRun.result.module,
        attempt_number: getAttemptCount(memory, "image-agent") + 1,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        retry_reason: retryReason,
        status: imageRun.result.status,
        needs_review: imageRun.result.needs_review,
        summary: imageRun.result.reasoning[0] ?? imageRun.result.status,
        provider_usage: (imageRun.result.artifacts?.provider_usage as any) ?? null,
        input_snapshot: asLooseRecord(buildRetryContext(currentRecord, lastQaFeedback, memory.learning_records)),
        output_snapshot: { proposed_changes: imageRun.result.proposed_changes, warnings: imageRun.result.warnings, artifacts: imageRun.result.artifacts }
      });
      if (nextAction !== "initial") memory.image_retries += 1;
      modules.push({ module: imageRun.result.module, job_id: imageRun.job_id, status: imageRun.result.status, needs_review: imageRun.result.needs_review });
      args.onProgress?.(`  -> image-optimizer ... ${imageRun.result.status}${imageRun.result.needs_review ? " (needs review)" : ""}`);
    }

    args.onProgress?.("  -> catalogue-qa ...");
    const qaRun = await args.executeModule("catalogue-qa", buildRetryContext(currentRecord, lastQaFeedback, memory.learning_records), async (jobId) => {
      const execution = await runQaAgent({
        root: args.root,
        jobId,
        input: buildRetryContext(currentRecord, lastQaFeedback, memory.learning_records),
        policy: args.policy,
        attemptNumber: getAttemptCount(memory, "qa-agent") + 1,
        retryReason: memory.last_retry_reason,
        parentAttempt: getAttemptCount(memory, "qa-agent") || null
      });
      return execution.result;
    });
    executions.push(qaRun);
    currentRecord = buildGeneratedProduct(currentRecord, qaRun.result) as ProductRecord;
    await args.persistGeneratedOutputs(currentRecord, qaRun.result);
    modules.push({ module: qaRun.result.module, job_id: qaRun.job_id, status: qaRun.result.status, needs_review: qaRun.result.needs_review });
    args.onProgress?.(`  -> catalogue-qa ... ${qaRun.result.status}${qaRun.result.needs_review ? " (needs review)" : ""}`);

    const qaFeedback = (qaRun.result.artifacts?.qa_retry_feedback as QaRetryFeedback | undefined) ?? {
      fixable_findings: [],
      hard_blockers: [],
      review_blockers: [],
      retry_targets: [],
      retry_instructions: [],
      confidence_delta: 0,
      recommended_next_agent: null
    };

    const qaAttemptNumber = getAttemptCount(memory, "qa-agent") + 1;
    memory.attempts.push({
      agent_id: "qa-agent",
      module: qaRun.result.module,
      attempt_number: qaAttemptNumber,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      retry_reason: memory.last_retry_reason,
      status: qaRun.result.status,
      needs_review: qaRun.result.needs_review,
      summary: qaRun.result.reasoning[0] ?? qaRun.result.status,
      provider_usage: (qaRun.result.artifacts?.provider_usage as any) ?? null,
      input_snapshot: asLooseRecord(buildRetryContext(currentRecord, lastQaFeedback, memory.learning_records)),
      output_snapshot: { proposed_changes: qaRun.result.proposed_changes, warnings: qaRun.result.warnings, artifacts: qaRun.result.artifacts }
    });
    memory.total_iterations += 1;
    memory.qa_feedback = qaFeedback;
    lastQaFeedback = qaFeedback;

    const learningRecords = await appendLearningRecords(args.root, buildLearningRecords(productKey, qaFeedback, "qa-agent"));
    if (learningRecords.length > 0) {
      memory.learning_records.push(...learningRecords);
    }

    const passed = qaRun.result.status === "passed" && !qaRun.result.needs_review;
    const decision = decideSupervisorAction({
      runtimeConfig: args.runtimeConfig,
      memory,
      qaPassed: passed,
      qaNeedsReview: qaRun.result.needs_review,
      qaFeedback,
      lastModuleStatus: qaRun.result.status
    });
    memory.last_retry_reason = decision.reason;
    memory.supervisor_decisions.push(decision);

    if (decision.action === "accept" || decision.action === "review" || decision.action === "reject") {
      const memoryPath = await saveWorkflowMemory(args.root, memory);
      return {
        currentRecord: {
          ...currentRecord,
          _catalog_agent_run: {
            attempts: memory.attempts,
            supervisor_decisions: memory.supervisor_decisions,
            learning_records: memory.learning_records,
            memory_path: memoryPath
          }
        },
        modules,
        executions,
        productKey,
        sourceRecordId,
        imageDirectory,
        selectedImageUrl,
        localImagePath,
        memoryPath,
        skipSync: false
      };
    }

    nextAction = decision.action;
  }
}
