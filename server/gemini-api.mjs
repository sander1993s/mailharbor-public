import { performance } from 'node:perf_hooks';
import { buildPrompt } from './runner.mjs';
import { createMailClassifier, validateWireRequest, classificationPrompt, normalizeWireResult } from './mail-classifier.mjs';
import { MAIL_CATEGORIES, MAIL_CLASSIFICATION_SCHEMA, normalizeMailDate, parseMailDate } from './mail-policy.mjs';
import { validateNotificationSummaryRequest, notificationSummaryPrompt, notificationSummaryResult } from './mail-notification-summary.mjs';
import { MailHarborError, errorMessages, validateRequest, validateResult } from './validation.mjs';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_MAX_SPEND_MICROS = 12_000_000; // $12.00 default hard cap (configurable up to $100.00)
export const MIN_MAX_SPEND_MICROS = 500_000; // $0.50
export const MAX_MAX_SPEND_MICROS = 100_000_000; // $100.00
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';

export const GEMINI_MODELS = Object.freeze([
  Object.freeze({
    id: 'gemini-3.5-flash-lite',
    fallbackEndpointId: 'gemini-flash-lite-latest',
    label: 'Gemini 3.5 Flash-Lite ($0.30 / $2.50 per 1M · Newest Flash-Lite · ~$9.80 for remaining backlog)',
    inputMicrosPer1M: 300_000,
    cachedMicrosPer1M: 30_000,
    outputMicrosPer1M: 2_500_000,
    thinkingConfig: Object.freeze({ thinkingLevel: 'minimal' })
  }),
  Object.freeze({
    id: 'gemini-flash-lite-latest',
    label: 'Gemini Flash-Lite Latest (Auto-tracks newest Google Flash-Lite)',
    inputMicrosPer1M: 300_000,
    cachedMicrosPer1M: 30_000,
    outputMicrosPer1M: 2_500_000,
    thinkingConfig: Object.freeze({ thinkingLevel: 'minimal' })
  }),
  Object.freeze({
    id: 'gemini-3.1-flash-lite',
    fallbackEndpointId: 'gemini-3.1-flash-lite-preview',
    label: 'Gemini 3.1 Flash-Lite ($0.25 / $1.50 per 1M · ~$8 for remaining backlog)',
    inputMicrosPer1M: 250_000,
    cachedMicrosPer1M: 25_000,
    outputMicrosPer1M: 1_500_000,
    thinkingConfig: Object.freeze({ thinkingLevel: 'minimal' })
  }),
  Object.freeze({
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite ($0.10 / $0.40 per 1M · ~$4 for remaining backlog)',
    inputMicrosPer1M: 100_000,
    cachedMicrosPer1M: 25_000,
    outputMicrosPer1M: 400_000,
    thinkingConfig: Object.freeze({ thinkingBudget: 0 })
  }),
  Object.freeze({
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash ($0.30 / $2.50 per 1M)',
    inputMicrosPer1M: 300_000,
    cachedMicrosPer1M: 30_000,
    outputMicrosPer1M: 2_500_000,
    thinkingConfig: Object.freeze({ thinkingBudget: 0 })
  })
]);

const MODEL_MAP = new Map(GEMINI_MODELS.map(model => [model.id, model]));
const CATEGORY_IDS = Object.freeze(MAIL_CATEGORIES.map(category => category.id));
const MAIL_SAFETY_SETTINGS = Object.freeze([
  Object.freeze({ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }),
  Object.freeze({ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }),
  Object.freeze({ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }),
  Object.freeze({ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }),
  Object.freeze({ category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' })
]);

function buildClassificationResponseSchema() {
  return {
    type: 'OBJECT',
    required: ['items'],
    properties: {
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          required: ['id', 'labels', 'confidence', 'junk', 'junkConfidence'],
          properties: {
            id: { type: 'STRING' },
            labels: {
              type: 'ARRAY',
              items: { type: 'STRING', enum: CATEGORY_IDS }
            },
            confidence: { type: 'NUMBER' },
            junk: { type: 'STRING', enum: [...MAIL_CLASSIFICATION_SCHEMA.junkValues] },
            junkConfidence: { type: 'NUMBER' },
            dateConfidence: { type: 'NUMBER', nullable: true },
            dates: {
              type: 'OBJECT',
              nullable: true,
              properties: {
                couponExpiry: { type: 'STRING', nullable: true },
                tenderDeadline: { type: 'STRING', nullable: true },
                appointmentStart: { type: 'STRING', nullable: true },
                appointmentEnd: { type: 'STRING', nullable: true }
              }
            },
            appointment: {
              type: 'OBJECT',
              nullable: true,
              required: ['title', 'location'],
              properties: {
                title: { type: 'STRING' },
                location: { type: 'STRING' }
              }
            }
          }
        }
      }
    }
  };
}

function canonicalizeWireClassification(parsed, request) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.items)) return parsed;
  const maxYear = new Date().getUTCFullYear() + MAIL_CLASSIFICATION_SCHEMA.futureYears;
  const items = parsed.items.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const item = {
      id: raw.id,
      labels: Array.isArray(raw.labels) ? [...new Set(raw.labels)] : raw.labels,
      confidence: raw.confidence,
      junk: raw.junk,
      junkConfidence: raw.junkConfidence
    };
    const labelSet = new Set(Array.isArray(item.labels) ? item.labels : []);
    if (raw.dates && typeof raw.dates === 'object' && !Array.isArray(raw.dates)) {
      const cleanDates = {};
      for (const key of MAIL_CLASSIFICATION_SCHEMA.dateFields) {
        const val = raw.dates[key];
        if (typeof val !== 'string' || !val.trim()) continue;
        const normalized = normalizeMailDate(val.trim());
        const parsedDate = parseMailDate(normalized);
        if (!parsedDate || parsedDate.year > maxYear) continue;
        if (key === 'couponExpiry' && !labelSet.has('coupons')) continue;
        if (key === 'tenderDeadline' && !labelSet.has('tenders')) continue;
        if ((key === 'appointmentStart' || key === 'appointmentEnd') && !labelSet.has('appointments')) continue;
        cleanDates[key] = normalized;
      }
      if (cleanDates.appointmentStart || cleanDates.appointmentEnd) {
        const start = cleanDates.appointmentStart ? parseMailDate(cleanDates.appointmentStart) : null;
        const end = cleanDates.appointmentEnd ? parseMailDate(cleanDates.appointmentEnd) : null;
        const startMs = start ? (start.dateOnly ? start.timestamp : Date.parse(cleanDates.appointmentStart)) : NaN;
        const endMs = end ? (end.dateOnly ? end.timestamp + 86_400_000 : Date.parse(cleanDates.appointmentEnd)) : NaN;
        if (!start || !end || start.dateOnly !== end.dateOnly || !(endMs > startMs)) {
          delete cleanDates.appointmentStart;
          delete cleanDates.appointmentEnd;
        }
      }
      if (Object.keys(cleanDates).length > 0) {
        item.dates = cleanDates;
        item.dateConfidence = typeof raw.dateConfidence === 'number' && Number.isFinite(raw.dateConfidence) &&
          raw.dateConfidence >= 0 && raw.dateConfidence <= 1 ? raw.dateConfidence : 0;
      }
    }
    if (item.dates?.appointmentStart && item.dates?.appointmentEnd &&
        raw.appointment && typeof raw.appointment === 'object' && !Array.isArray(raw.appointment)) {
      const title = typeof raw.appointment.title === 'string'
        ? raw.appointment.title.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, MAIL_CLASSIFICATION_SCHEMA.titleLimit)
        : '';
      const location = typeof raw.appointment.location === 'string'
        ? raw.appointment.location.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, MAIL_CLASSIFICATION_SCHEMA.locationLimit)
        : '';
      if (title) item.appointment = { title, location };
    }
    return item;
  });
  return { items };
}

function failure(code, reason) {
  return new MailHarborError(code, errorMessages[code], reason);
}

function parseJsonResponse(raw) {
  let source = String(raw ?? '').trim();
  if (!source) throw failure('invalid_model_output', 'response_json_empty');
  let fenced = false;
  if (source.startsWith('```')) {
    const match = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/u.exec(source);
    if (!match || match[1].includes('```')) throw failure('invalid_model_output', 'response_fence_invalid');
    source = match[1];
    fenced = true;
  }
  try {
    return JSON.parse(source);
  } catch {
    throw failure('invalid_model_output', fenced ? 'response_fenced_json_invalid' : 'response_json_invalid');
  }
}

function parseRetryDelayMs(headers, text) {
  const retryAfter = headers?.get?.('retry-after');
  if (retryAfter && /^\d{1,7}$/u.test(retryAfter.trim())) {
    const ms = Number(retryAfter.trim()) * 1000;
    if (ms > 0) return Math.min(7 * 86_400_000, Math.max(60_000, ms));
  }
  const match = /"retryDelay"\s*:\s*"(\d{1,7}(?:\.\d{1,3})?)s"/u.exec(String(text ?? ''));
  if (match) {
    const ms = Math.ceil(Number(match[1]) * 1000);
    if (Number.isFinite(ms) && ms > 0) return Math.min(7 * 86_400_000, Math.max(60_000, ms));
  }
  return null;
}

function validApiKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{19,255}$/u.test(value.trim());
}

function normalizeState(raw) {
  const model = MODEL_MAP.has(raw?.model) ? raw.model : DEFAULT_GEMINI_MODEL;
  const maxSpendMicros = Number.isSafeInteger(raw?.maxSpendMicros) &&
    raw.maxSpendMicros >= MIN_MAX_SPEND_MICROS && raw.maxSpendMicros <= MAX_MAX_SPEND_MICROS
    ? raw.maxSpendMicros
    : DEFAULT_MAX_SPEND_MICROS;
  const apiKey = validApiKey(raw?.apiKey) ? raw.apiKey.trim() : '';
  const enabled = raw?.enabled === true && Boolean(apiKey);
  const safeInt = val => (Number.isSafeInteger(val) && val >= 0 ? val : 0);
  return {
    enabled,
    apiKey,
    model,
    maxSpendMicros,
    spentMicros: safeInt(raw?.spentMicros),
    inputTokens: safeInt(raw?.inputTokens),
    outputTokens: safeInt(raw?.outputTokens),
    cachedTokens: safeInt(raw?.cachedTokens),
    requests: safeInt(raw?.requests),
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    resetAt: typeof raw?.resetAt === 'string' ? raw.resetAt : null
  };
}

function microsToUsd(micros) {
  return Math.round((micros / 1_000_000) * 10_000) / 10_000;
}

async function readBoundedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw failure('invalid_model_output', 'stream_output_limit');
    return text;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw failure('invalid_model_output', 'stream_output_limit');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function computeUsageMicros(modelSpec, usage, fallbackMicros) {
  if (!usage || typeof usage !== 'object') {
    return { micros: fallbackMicros, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  }
  const promptTokens = Math.max(0, Math.trunc(Number(usage.promptTokenCount) || 0));
  const cachedTokens = Math.min(promptTokens, Math.max(0, Math.trunc(Number(usage.cachedContentTokenCount) || 0)));
  const uncachedInput = Math.max(0, promptTokens - cachedTokens);
  const candidatesTokens = Math.max(0, Math.trunc(Number(usage.candidatesTokenCount) || 0));
  const thoughtsTokens = Math.max(0, Math.trunc(Number(usage.thoughtsTokenCount) || 0));
  const outputTokens = candidatesTokens + thoughtsTokens;
  if (promptTokens === 0 && outputTokens === 0) {
    return { micros: fallbackMicros, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  }
  const exactMicros = Math.ceil(
    (uncachedInput * modelSpec.inputMicrosPer1M +
      cachedTokens * modelSpec.cachedMicrosPer1M +
      outputTokens * modelSpec.outputMicrosPer1M) / 1_000_000
  );
  return {
    micros: Math.max(1, exactMicros),
    inputTokens: promptTokens,
    outputTokens,
    cachedTokens
  };
}

function extractCandidateText(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw failure('invalid_model_output', 'stream_result_invalid');
  }
  if (payload.promptFeedback?.blockReason) {
    throw failure('invalid_model_output', 'response_shape_invalid');
  }
  const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
  if (!candidate || typeof candidate !== 'object') {
    throw failure('invalid_model_output', 'stream_result_missing');
  }
  if (candidate.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(candidate.finishReason)) {
    if (candidate.finishReason === 'MAX_TOKENS') throw failure('invalid_model_output', 'stream_output_limit');
    throw failure('invalid_model_output', 'response_shape_invalid');
  }
  // Reject any functionCall / tool attempt just like the Agy runner.
  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  if (parts.some(part => part && (part.functionCall || part.executableCode || part.codeExecutionResult))) {
    throw failure('invalid_model_output', 'stream_tool_calls');
  }
  const text = parts
    .filter(part => part && part.thought !== true && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
  if (!text.trim()) throw failure('invalid_model_output', 'response_json_empty');
  return text;
}

/**
 * Encrypted, budget-capped direct Gemini Developer API service.
 * Never logs or exposes the stored API key, raw provider errors, or email text.
 */
export function createGeminiApi({ store, fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  let reservedMicros = 0;
  const resolvedEndpoints = new Map();

  function currentState() {
    try {
      return normalizeState(store?.read?.()?.geminiApi);
    } catch {
      return normalizeState(null);
    }
  }

  function isActive() {
    const state = currentState();
    return state.enabled && Boolean(state.apiKey);
  }

  function isBudgetReached(state = currentState()) {
    return state.spentMicros >= state.maxSpendMicros;
  }

  function status() {
    const state = currentState();
    const remainingMicros = Math.max(0, state.maxSpendMicros - state.spentMicros);
    return {
      enabled: state.enabled,
      configured: Boolean(state.apiKey),
      model: state.model,
      models: GEMINI_MODELS.map(({ id, label, inputMicrosPer1M, outputMicrosPer1M }) => ({
        id,
        label,
        inputUsdPer1M: microsToUsd(inputMicrosPer1M),
        outputUsdPer1M: microsToUsd(outputMicrosPer1M)
      })),
      maxSpendUsd: microsToUsd(state.maxSpendMicros),
      spentUsd: microsToUsd(state.spentMicros),
      remainingUsd: microsToUsd(remainingMicros),
      budgetReached: state.spentMicros >= state.maxSpendMicros,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cachedTokens: state.cachedTokens,
      requests: state.requests,
      updatedAt: state.updatedAt,
      resetAt: state.resetAt
    };
  }

  async function configure(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('invalid_request');
    const allowed = ['enabled', 'apiKey', 'clearKey', 'model', 'maxSpendUsd', 'resetSpend'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw failure('invalid_request');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw failure('invalid_request');
    if (input.clearKey !== undefined && typeof input.clearKey !== 'boolean') throw failure('invalid_request');
    if (input.resetSpend !== undefined && typeof input.resetSpend !== 'boolean') throw failure('invalid_request');
    if (input.model !== undefined && !MODEL_MAP.has(input.model)) throw failure('invalid_request');

    let nextKey;
    if (input.apiKey !== undefined) {
      if (typeof input.apiKey !== 'string') throw failure('invalid_request');
      const trimmed = input.apiKey.trim();
      if (trimmed !== '' && !validApiKey(trimmed)) throw failure('invalid_request');
      if (trimmed !== '') nextKey = trimmed;
    }

    let nextMaxSpendMicros;
    if (input.maxSpendUsd !== undefined) {
      const num = Number(input.maxSpendUsd);
      if (!Number.isFinite(num)) throw failure('invalid_request');
      const micros = Math.round(num * 1_000_000);
      if (micros < MIN_MAX_SPEND_MICROS || micros > MAX_MAX_SPEND_MICROS) throw failure('invalid_request');
      nextMaxSpendMicros = micros;
    }

    if (!store?.update) throw failure('configuration_error');
    await store.update(doc => {
      const prev = normalizeState(doc.geminiApi);
      const apiKey = input.clearKey ? '' : (nextKey ?? prev.apiKey);
      const enabled = apiKey ? (input.enabled !== undefined ? input.enabled : (nextKey ? true : prev.enabled)) : false;
      const timestamp = new Date(now()).toISOString();
      doc.geminiApi = {
        enabled,
        apiKey,
        model: input.model ?? prev.model,
        maxSpendMicros: nextMaxSpendMicros ?? prev.maxSpendMicros,
        spentMicros: input.resetSpend ? 0 : prev.spentMicros,
        inputTokens: input.resetSpend ? 0 : prev.inputTokens,
        outputTokens: input.resetSpend ? 0 : prev.outputTokens,
        cachedTokens: input.resetSpend ? 0 : prev.cachedTokens,
        requests: input.resetSpend ? 0 : prev.requests,
        updatedAt: timestamp,
        resetAt: input.resetSpend ? timestamp : prev.resetAt
      };
    });
    return status();
  }

  async function invokeJson({ prompt, responseSchema, safetySettings, maxOutputTokens = 4096, timeoutMs = 90_000, signal, onMetrics, overrideKey, overrideModel, recordSpend = true }) {
    if (signal?.aborted) throw signal.reason ?? failure('cancelled');
    const state = currentState();
    const apiKey = overrideKey !== undefined ? String(overrideKey).trim() : state.apiKey;
    if (!validApiKey(apiKey)) throw failure('login_required', 'provider_auth');
    const modelId = overrideModel ?? state.model;
    const modelSpec = MODEL_MAP.get(modelId);
    if (!modelSpec) throw failure('configuration_error');

    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    // Strict upper-bound reservation (1 token per 1.5 UTF-8 bytes + framing + maxOutputTokens)
    // guarantees concurrent batches can never exceed maxSpendMicros even before reconciliation.
    const estimatedInputTokens = Math.ceil(promptBytes / 1.5) + 512;
    const reservation = Math.max(
      1,
      Math.ceil((estimatedInputTokens * modelSpec.inputMicrosPer1M + maxOutputTokens * modelSpec.outputMicrosPer1M) / 1_000_000)
    );

    if (recordSpend) {
      if (state.spentMicros >= state.maxSpendMicros || state.spentMicros + reservedMicros + reservation > state.maxSpendMicros) {
        const err = failure('quota_exhausted', 'provider_budget_reached');
        err.cooldownMs = 7 * 86_400_000;
        throw err;
      }
      reservedMicros += reservation;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason ?? failure('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const boundedTimeout = Math.min(120_000, Math.max(1_000, timeoutMs ?? 90_000));
    const timer = setTimeout(() => controller.abort(failure('timeout', 'cli_timeout')), boundedTimeout);
    timer.unref?.();

    const startedAt = performance.now();
    let billed = null;
    try {
      const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        ...(safetySettings ? { safetySettings } : {}),
        generationConfig: {
          responseMimeType: 'application/json',
          ...(responseSchema ? { responseSchema } : {}),
          temperature: 0.1,
          maxOutputTokens,
          thinkingConfig: modelSpec.thinkingConfig
        }
      });

      const sendToModel = async endpointId => {
        const url = `${GEMINI_ORIGIN}/v1beta/models/${encodeURIComponent(endpointId)}:generateContent`;
        try {
          return await fetcher(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'x-goog-api-key': apiKey
            },
            body,
            signal: controller.signal,
            redirect: 'error'
          });
        } catch {
          if (controller.signal.aborted) throw controller.signal.reason ?? failure('timeout', 'cli_timeout');
          throw failure('provider_error', 'provider_failure');
        }
      };

      const preferredEndpoint = resolvedEndpoints.get(modelSpec.id) ?? modelSpec.id;
      let response = await sendToModel(preferredEndpoint);
      let rawText = await readBoundedText(response);
      if (response.status === 404 && modelSpec.fallbackEndpointId && preferredEndpoint !== modelSpec.fallbackEndpointId) {
        response = await sendToModel(modelSpec.fallbackEndpointId);
        rawText = await readBoundedText(response);
        if (response.ok) resolvedEndpoints.set(modelSpec.id, modelSpec.fallbackEndpointId);
      } else if (response.ok) {
        resolvedEndpoints.set(modelSpec.id, preferredEndpoint);
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || /API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/iu.test(rawText)) {
          throw failure('login_required', 'provider_auth');
        }
        if (response.status === 429 || /RESOURCE_EXHAUSTED|RATE_LIMIT/iu.test(rawText)) {
          const err = failure('quota_exhausted', 'provider_rate_limit');
          err.cooldownMs = parseRetryDelayMs(response.headers, rawText) ?? 60_000;
          throw err;
        }
        if (response.status === 404 || /NOT_FOUND|model.*not found/iu.test(rawText)) {
          throw failure('configuration_error');
        }
        throw failure('provider_error', 'provider_failure');
      }

      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch {
        throw failure('invalid_model_output', 'stream_json_invalid');
      }

      billed = computeUsageMicros(modelSpec, payload.usageMetadata, reservation);
      const candidateText = extractCandidateText(payload);
      return parseJsonResponse(candidateText);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const responseMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (typeof onMetrics === 'function') {
        try { onMetrics({ startupMs: 0, responseMs }); } catch {}
      }
      if (recordSpend) {
        try {
          if (billed && store?.update) {
            await store.update(doc => {
              const prev = normalizeState(doc.geminiApi);
              doc.geminiApi = {
                ...prev,
                spentMicros: prev.spentMicros + billed.micros,
                inputTokens: prev.inputTokens + billed.inputTokens,
                outputTokens: prev.outputTokens + billed.outputTokens,
                cachedTokens: prev.cachedTokens + billed.cachedTokens,
                requests: prev.requests + 1,
                updatedAt: new Date(now()).toISOString()
              };
            });
          }
        } catch {} finally {
          reservedMicros = Math.max(0, reservedMicros - reservation);
        }
      }
    }
  }

  async function testConnection(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('invalid_request');
    if (Object.keys(input).some(key => !['apiKey', 'model'].includes(key))) throw failure('invalid_request');
    const state = currentState();
    const key = input.apiKey !== undefined && String(input.apiKey).trim() !== '' ? String(input.apiKey).trim() : state.apiKey;
    if (!validApiKey(key)) throw failure('invalid_request');
    const model = input.model ?? state.model;
    if (!MODEL_MAP.has(model)) throw failure('invalid_request');
    const started = performance.now();
    const parsed = await invokeJson({
      prompt: 'Return strict JSON: {"ok":true}',
      maxOutputTokens: 32,
      timeoutMs: 20_000,
      overrideKey: key,
      overrideModel: model,
      recordSpend: true
    });
    if (!parsed || parsed.ok !== true) throw failure('invalid_model_output', 'response_shape_invalid');
    return { ok: true, model, latencyMs: Math.max(1, Math.round(performance.now() - started)), status: status() };
  }

  const runWireClassification = async (wireRequest, config = {}, signal) => {
    const validated = validateWireRequest(wireRequest);
    const maxOutputTokens = Math.min(8192, Math.max(512, validated.messages.length * 180));
    const parsed = await invokeJson({
      prompt: classificationPrompt(validated),
      responseSchema: buildClassificationResponseSchema(),
      safetySettings: MAIL_SAFETY_SETTINGS,
      maxOutputTokens,
      timeoutMs: config?.timeoutMs,
      signal,
      onMetrics: config?.onMetrics
    });
    return normalizeWireResult(canonicalizeWireClassification(parsed, validated), validated);
  };

  const classificationRunner = createMailClassifier({ runWire: runWireClassification });

  async function briefingRunner(requestValue, config = {}, signal) {
    const request = validateRequest(requestValue);
    const parsed = await invokeJson({
      prompt: buildPrompt(request),
      safetySettings: MAIL_SAFETY_SETTINGS,
      maxOutputTokens: 8192,
      timeoutMs: config?.timeoutMs,
      signal,
      onMetrics: config?.onMetrics
    });
    return validateResult(parsed, request);
  }

  async function notificationSummaryRunner(requestValue, config = {}, signal) {
    const request = validateNotificationSummaryRequest(requestValue);
    const parsed = await invokeJson({
      prompt: notificationSummaryPrompt(request),
      safetySettings: MAIL_SAFETY_SETTINGS,
      maxOutputTokens: Math.min(8192, Math.max(512, request.messages.length * 250)),
      timeoutMs: config?.timeoutMs,
      signal,
      onMetrics: config?.onMetrics
    });
    return notificationSummaryResult(parsed, request);
  }

  return {
    isActive,
    isBudgetReached,
    model: () => currentState().model,
    status,
    configure,
    test: testConnection,
    briefingRunner,
    classificationRunner,
    notificationSummaryRunner
  };
}
