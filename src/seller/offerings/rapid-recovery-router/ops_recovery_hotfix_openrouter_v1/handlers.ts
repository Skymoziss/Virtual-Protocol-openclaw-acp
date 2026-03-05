import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";
import { buildRecoveryPack, type RecoveryPackInput } from "../../../runtime/openrouterRecovery.js";

const OFFERING_NAME = "ops_recovery_hotfix_openrouter_v1";

function normalizeObject(input: unknown): Record<string, any> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, any>)
    : {};
}

function toInput(request: Record<string, any>): RecoveryPackInput {
  return {
    error_text: String(request.error_text || "").trim(),
    failed_payload: String(request.failed_payload || "").trim() || undefined,
    target_system: String(request.target_system || "").trim() || undefined,
    persona_mode: String(request.persona_mode || "").trim() || undefined,
    buyer_goal: String(request.buyer_goal || "").trim() || undefined,
    model_override: String(request.model_override || "").trim() || undefined,
  };
}

export async function executeJob(request: any): Promise<ExecuteJobResult> {
  const normalized = normalizeObject(request);
  const input = toInput(normalized);
  const recoveryPack = await buildRecoveryPack(input);

  return {
    deliverable: {
      type: "json",
      value: {
        service: "ops-recovery-hotfix",
        offering: OFFERING_NAME,
        input,
        recovery: recoveryPack,
        notes: [
          "OpenRouter key is optional. If missing, deterministic fallback pack is returned.",
          "To force free models, set OPENROUTER_FREE_MODEL (e.g. ...:free).",
        ],
      },
    },
  };
}

export function validateRequirements(request: any): ValidationResult {
  const normalized = normalizeObject(request);
  const errorText = String(normalized.error_text || "").trim();
  if (!errorText) return { valid: false, reason: "error_text is required" };
  if (errorText.length > 4000) return { valid: false, reason: "error_text is too long (max 4000)" };

  const persona = String(normalized.persona_mode || "")
    .trim()
    .toLowerCase();
  if (persona && !["price", "speed", "completion"].includes(persona)) {
    return { valid: false, reason: "persona_mode must be one of: price, speed, completion" };
  }

  return { valid: true };
}

export function requestPayment(): string {
  return "Ops recovery request accepted. Generating retry-safe hotfix pack now.";
}
