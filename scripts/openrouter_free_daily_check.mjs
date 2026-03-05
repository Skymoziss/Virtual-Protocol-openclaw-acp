#!/usr/bin/env node

import { execFileSync } from "child_process";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_SITE_URL = "https://app.virtuals.io";
const DEFAULT_APP_NAME = "acp-ops-recovery-router";

const argv = new Set(process.argv.slice(2));
const shouldApply = argv.has("--apply");
const shouldDeploy = argv.has("--deploy");
const verbose = argv.has("--verbose");

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  }).trim();
}

function runInherit(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

function toVarsMap(rawJson) {
  const parsed = JSON.parse(rawJson);
  if (Array.isArray(parsed)) {
    return Object.fromEntries(parsed.map((entry) => [entry.name, String(entry.value ?? "")]));
  }
  if (parsed && typeof parsed === "object") {
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, String(value ?? "")])
    );
  }
  throw new Error("Unexpected format from `railway variables --json`.");
}

function isFreeModel(model) {
  const pricing = model?.pricing ?? {};
  const prompt = Number(pricing.prompt ?? pricing.input ?? Number.NaN);
  const completion = Number(pricing.completion ?? pricing.output ?? Number.NaN);
  return prompt === 0 && completion === 0;
}

function isTextCapable(model) {
  const modalities = model?.architecture?.input_modalities;
  if (!Array.isArray(modalities) || modalities.length === 0) return true;
  return modalities.includes("text");
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

async function probeModel({ apiKey, baseUrl, siteUrl, appName, modelId }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const requestBody = {
    model: modelId,
    temperature: 0,
    max_tokens: 120,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Return strict JSON with keys: classification, lane, summary, retry_payload, next_actions, message_templates, confidence.",
      },
      {
        role: "user",
        content: JSON.stringify({
          input: {
            error_text: "timeout while waiting for response from target agent",
            target_system: "acp",
            persona_mode: "speed",
          },
        }),
      },
    ],
  };

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": siteUrl,
        "X-Title": appName,
      },
      body: JSON.stringify(requestBody),
    });

    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: body.slice(0, 300),
      };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }

    const content =
      parsed?.choices?.[0]?.message?.content &&
      typeof parsed.choices[0].message.content === "string"
        ? parsed.choices[0].message.content
        : "";

    return {
      ok: content.length > 0,
      status: response.status,
      usage: parsed?.usage ?? null,
      error: content.length > 0 ? null : "empty model content",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const railwayVars = toVarsMap(run("railway", ["variables", "--json"]));
  const apiKey = railwayVars.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || "";
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing (Railway/env).");
  }

  const baseUrl = (railwayVars.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).replace(
    /\/$/,
    ""
  );
  const siteUrl = railwayVars.OPENROUTER_SITE_URL || DEFAULT_SITE_URL;
  const appName = railwayVars.OPENROUTER_APP_NAME || DEFAULT_APP_NAME;
  const currentModel = railwayVars.OPENROUTER_FREE_MODEL || "";

  const modelsResponse = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!modelsResponse.ok) {
    throw new Error(`Failed to fetch models: HTTP ${modelsResponse.status}`);
  }
  const modelsJson = await modelsResponse.json();
  const allModels = Array.isArray(modelsJson?.data) ? modelsJson.data : [];
  const freeModels = allModels.filter((model) => isFreeModel(model) && isTextCapable(model));
  const freeIds = new Set(freeModels.map((model) => model.id));

  const preferred = unique([
    currentModel,
    "openrouter/free",
    "qwen/qwen3-coder:free",
    "openai/gpt-oss-20b:free",
    "openai/gpt-oss-120b:free",
    "google/gemma-3-27b-it:free",
    "mistralai/mistral-small-3.1-24b-instruct:free",
    ...freeModels.map((model) => model.id),
  ]).filter((modelId) => freeIds.has(modelId));

  if (preferred.length === 0) {
    throw new Error("No text-capable free models available.");
  }

  const probes = [];
  let selected = null;
  for (const modelId of preferred) {
    const result = await probeModel({ apiKey, baseUrl, siteUrl, appName, modelId });
    probes.push({ modelId, ...result });
    if (result.ok) {
      selected = { modelId, usage: result.usage ?? null };
      break;
    }
  }

  if (!selected) {
    throw new Error(`All free-model probes failed: ${JSON.stringify(probes, null, 2)}`);
  }

  const selectedMeta = freeModels.find((model) => model.id === selected.modelId) ?? null;
  const promptCostPerToken = Number(
    selectedMeta?.pricing?.prompt ?? selectedMeta?.pricing?.input ?? 0
  );
  const completionCostPerToken = Number(
    selectedMeta?.pricing?.completion ?? selectedMeta?.pricing?.output ?? 0
  );
  const promptTokens = Number(selected.usage?.prompt_tokens ?? 0);
  const completionTokens = Number(selected.usage?.completion_tokens ?? 0);
  const estimatedUsd =
    promptTokens * promptCostPerToken + completionTokens * completionCostPerToken;

  if (shouldApply) {
    runInherit("railway", ["variables", "set", `OPENROUTER_FREE_MODEL=${selected.modelId}`]);
    try {
      runInherit("railway", ["variables", "delete", "OPENROUTER_MODEL"]);
    } catch {
      // OPENROUTER_MODEL may not exist; ignore.
    }
    if (shouldDeploy) {
      runInherit("npx", ["tsx", "bin/acp.ts", "serve", "deploy", "railway"]);
    }
  }

  const summary = {
    timestamp: new Date().toISOString(),
    applied: shouldApply,
    deployed: shouldApply && shouldDeploy,
    selectedModel: selected.modelId,
    currentModelBefore: currentModel || null,
    freeModelsCount: freeModels.length,
    estimatedUsdPerProbe: estimatedUsd,
    usage: {
      promptTokens,
      completionTokens,
    },
    probes: verbose ? probes : probes.slice(0, 5),
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    ) + "\n"
  );
  process.exit(1);
});
