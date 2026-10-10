/**
 * ChatGPT backend search provider — for ChatGPT Plus / OpenAI OAuth users.
 *
 * Uses the same Responses API format as the public OpenAI API, but hits the
 * ChatGPT backend endpoint which accepts OAuth access tokens instead of API keys.
 *
 * Auth flow mirrors the Pi SDK's `openai-codex-responses.js`:
 *   - Bearer token: the OAuth access token
 *   - chatgpt-account-id: extracted from the JWT's claims
 */

import type { WebSearchProvider, WebSearchResult } from '../types.ts';
import { carryFailedResponse, rememberFailedResponse } from '../failure-evidence.ts';
import { parseResponsesApiResults, type ResponsesApiResponse } from './responses-api-parser.ts';
import { isModelRejectionError } from '../../../model-resolution.ts';
import { stripPiPrefix } from '../../../custom-endpoint-models.ts';
import { PI_PREFERRED_DEFAULTS } from '../../../../../shared/src/config/llm-connections.ts';

/**
 * Codex backend request contract (search path):
 * - model: derived from the active connection (see `candidateModels`), NOT hardcoded.
 *   Pinning a single model caused a total search outage once that model was retired
 *   (craft-agents-oss#1023) — the account rejected it with a 400 and search never
 *   recovered. Candidates come from the shared openai-codex catalog and an unsupported
 *   model is retried against the next candidate.
 * - store: false
 * - stream: true (backend may return JSON or SSE)
 * - instructions + tool_choice + text.verbosity
 * - OpenAI-Beta: responses=experimental header
 *
 * If this payload changes, update:
 *   - ./chatgpt.test.ts
 *   - ../SEARCH_PAYLOAD_CONTRACT.md
 */
// Search model candidates for the ChatGPT backend, in preference order. Sourced from the
// shared openai-codex catalog so they track the models the rest of the app offers and can't
// drift into a stale hardcoded value. The plumbed active model (if any) is tried first.
const CODEX_SEARCH_MODELS: readonly string[] = PI_PREFERRED_DEFAULTS['openai-codex'] ?? [];
const FALLBACK_SEARCH_MODEL = CODEX_SEARCH_MODELS[0] ?? 'gpt-6-astra';
// Bound the failover chain: the active model plus a few catalog fallbacks. The catalog's
// tail (o3/gpt-4o era) is the least likely to be accepted by a ChatGPT-plan account, so a
// longer chain adds sequential 400 round-trips before the DDG fallback, not recovery odds.
const MAX_MODEL_CANDIDATES = 4;
const API_BASE = 'https://chatgpt.com/backend-api/codex';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const ERROR_TEXT_LIMIT = 600;
const SEARCH_INSTRUCTIONS = 'You are a web search assistant. Return concise, factual search results with source citations when available.';
const SEARCH_TEXT_VERBOSITY = 'medium';

interface SearchAttempt {
  toolType: 'web_search' | 'web_search_preview';
  label: string;
}

const SEARCH_ATTEMPTS: SearchAttempt[] = [
  { toolType: 'web_search', label: 'web_search' },
  { toolType: 'web_search_preview', label: 'web_search_preview' },
];

/**
 * Extract the `chatgpt_account_id` from a ChatGPT OAuth access token (JWT).
 * Returns null if the token is malformed or the claim is missing.
 */
export function extractChatGptAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(atob(parts[1]!));
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;

    return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
  } catch {
    return null;
  }
}

export class ChatGPTBackendSearchProvider implements WebSearchProvider {
  name = 'ChatGPT';

  constructor(
    private accessToken: string,
    private accountId: string,
    private options?: { model?: string },
  ) {}

  async search(query: string, count: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const attemptErrors: string[] = [];
    let lastResponseFailure: Error | undefined;
    const fail = (): never => {
      const error = new Error(`ChatGPT search failed: ${summarizeAttemptErrors(attemptErrors)}`);
      carryFailedResponse(lastResponseFailure, error);
      throw error;
    };
    const models = this.candidateModels();

    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
      const model = models[modelIndex]!;
      const hasMoreModels = modelIndex < models.length - 1;
      let modelRejected = false;

      for (let attemptIndex = 0; attemptIndex < SEARCH_ATTEMPTS.length; attemptIndex++) {
        const attempt = SEARCH_ATTEMPTS[attemptIndex]!;
        const hasMoreAttempts = attemptIndex < SEARCH_ATTEMPTS.length - 1;

        const requestBody = {
          model,
          store: false,
          stream: true,
          instructions: SEARCH_INSTRUCTIONS,
          tools: [{ type: attempt.toolType }],
          tool_choice: 'auto',
          parallel_tool_calls: true,
          text: { verbosity: SEARCH_TEXT_VERBOSITY },
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: `Search the web for: ${query}\n\nReturn the top ${count} results with title, URL, and a brief description.`,
                },
              ],
            },
          ],
        };

        const requestFingerprint = buildRequestFingerprint(requestBody);

        const response = await fetch(`${API_BASE}/responses`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.accessToken}`,
            'chatgpt-account-id': this.accountId,
            'OpenAI-Beta': 'responses=experimental',
          },
          body: JSON.stringify(requestBody),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });

        const contentType = response.headers.get('content-type') || 'unknown';
        const safeContentType = contentType.split(';', 1)[0]!.replace(/[^a-zA-Z0-9/.-]/g, '').slice(0, 80) || 'unknown';

        if (response.ok) {
          try {
            const data = await parseResponsePayload(response);
            return parseResponsesApiResults(data, query, count);
          } catch (parseError) {
            if (parseError instanceof Error) lastResponseFailure = parseError;
            attemptErrors.push(
              `${attempt.label} parse failed [${requestFingerprint}, content-type=${safeContentType}]: ${safeParseFailure(parseError)}`,
            );

            if (hasMoreAttempts) {
              continue;
            }

            fail();
          }
        }

        const errorText = await readLimitedResponseText(response);
        const responseFailure = new Error(`HTTP ${response.status}`);
        rememberFailedResponse(responseFailure, { raw: errorText, status: response.status, contentType });
        lastResponseFailure = responseFailure;
        attemptErrors.push(
          `${attempt.label} failed (HTTP ${response.status}) [${requestFingerprint}, content-type=${safeContentType}]: ${safeErrorCode(errorText)}`,
        );

        // Unsupported-model refusal (e.g. the account rejects a retired model): the tool type
        // is irrelevant, so abandon this model and try the next candidate instead of wasting the
        // remaining tool-type retry on the same dead model. This is what makes search self-heal
        // when a pinned/derived model falls out of the account's supported set (#1023).
        // The predicate requires the message to name the model, so a hosted-tool refusal that
        // also says "is not supported" still takes the tool-type retry below, not this branch.
        if (response.status === 400 && isModelRejectionError(errorText, model)) {
          modelRejected = true;
          break;
        }

        // Other 400 → likely schema/tool incompatibility → retry with the next tool type.
        const canRetry = response.status === 400;
        if (!(canRetry && hasMoreAttempts)) {
          fail();
        }
      }

      // The model was rejected as unsupported: advance to the next candidate if one exists.
      if (modelRejected && hasMoreModels) {
        continue;
      }
      if (modelRejected) fail();
    }

    return fail();
  }

  /**
   * Build the ordered, de-duplicated list of bare model IDs to try: the plumbed active model
   * first (so search uses the model the user is actually on), then the shared openai-codex
   * catalog as fallbacks, capped at MAX_MODEL_CANDIDATES. Never empty — always yields at
   * least FALLBACK_SEARCH_MODEL.
   */
  private candidateModels(): string[] {
    const ordered = [this.options?.model, ...CODEX_SEARCH_MODELS, FALLBACK_SEARCH_MODEL];
    const seen = new Set<string>();
    const models: string[] = [];
    for (const raw of ordered) {
      if (!raw) continue;
      const bare = stripPiPrefix(raw);
      if (bare && !seen.has(bare)) {
        seen.add(bare);
        models.push(bare);
      }
    }
    return models.length > 0 ? models.slice(0, MAX_MODEL_CANDIDATES) : [FALLBACK_SEARCH_MODEL];
  }
}

async function parseResponsePayload(response: Response): Promise<ResponsesApiResponse> {
  const contentType = response.headers.get('content-type') || '';
  const raw = await readLimitedResponseText(response);
  try {
    const looksLikeSse =
      contentType.includes('text/event-stream') ||
      raw.startsWith('event:') ||
      raw.includes('\ndata:') ||
      raw.includes('\n\nevent:');

    if (looksLikeSse) return parseSseResponsePayload(raw);
    try {
      return JSON.parse(raw) as ResponsesApiResponse;
    } catch {
      throw new Error('ChatGPT search response parse failed: expected JSON or SSE payload');
    }
  } catch (error) {
    if (error instanceof Error) rememberFailedResponse(error, { raw, status: response.status, contentType });
    throw error;
  }
}

// A streaming provider can send an unending or enormous response. Bound bytes
// *before* response.text() would allocate the whole body in process memory.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
async function readLimitedResponseText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        const error = new Error('ChatGPT search response exceeded the 2 MiB safety limit');
        rememberFailedResponse(error, {
          raw: text.slice(0, 64 * 1024), status: response.status,
          contentType: response.headers.get('content-type') || 'unknown',
        });
        throw error;
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

const KNOWN_SSE_EVENT_TYPES = new Set([
  'response.created', 'response.in_progress', 'response.completed', 'response.done',
  'response.failed', 'response.incomplete', 'response.output_item.added',
  'response.output_item.done', 'response.content_part.added', 'response.content_part.done',
  'response.output_text.delta', 'response.output_text.done', 'response.web_search_call.in_progress',
  'response.web_search_call.completed', 'error',
]);

function parseSseResponsePayload(sseText: string): ResponsesApiResponse {
  let completed: ResponsesApiResponse | null = null;
  let terminalFailure: string | null = null;
  let parsedEvents = 0;
  let invalidJson = 0;
  let doneMarkers = 0;
  let completionWithoutPayload = 0;
  const eventKinds = new Map<string, number>();

  // SSE permits CRLF and CR as well as LF; normalize before splitting events.
  for (const chunk of sseText.replace(/\r\n?/g, '\n').split('\n\n')) {
    const dataLines = chunk
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(Boolean);

    for (const line of dataLines) {
      if (line === '[DONE]') {
        doneMarkers++;
        continue;
      }
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        invalidJson++;
        continue;
      }
      parsedEvents++;
      // Only the event type and counts are retained. Never keep the stream
      // body here: it can contain the user's query or returned page content.
      const rawKind = event?.type;
      const kind = typeof rawKind === 'string' && KNOWN_SSE_EVENT_TYPES.has(rawKind) ? rawKind : 'unrecognized';
      eventKinds.set(kind, (eventKinds.get(kind) ?? 0) + 1);

      if (event?.type === 'response.completed' || event?.type === 'response.done') {
        if (event.response && typeof event.response === 'object') {
          completed = event.response as ResponsesApiResponse;
        } else {
          completionWithoutPayload++;
        }
      } else if (event?.type === 'response.failed' || event?.type === 'response.incomplete' || event?.type === 'error') {
        // Do not include raw SSE: it may contain the query or other response data.
        const code = event.response?.error?.code ?? event.error?.code ?? event.response?.incomplete_details?.reason;
        // Provider-controlled message can echo queries or page content. Keep
        // only a constrained error code in the transcript; raw body is held
        // for opt-in encrypted capture if *all* search providers fail.
        terminalFailure = `${kind}${typeof code === 'string' ? ` (${safeErrorCodeTag(code)})` : ''}`;
      }
    }
  }

  if (!completed) {
    const kinds = [...eventKinds].slice(0, 6).map(([kind, count]) => `${kind}:${count}`).join(',') || 'none';
    const trace = `streamChars=${sseText.length}, parsedEvents=${parsedEvents}, invalidJson=${invalidJson}, doneMarkers=${doneMarkers}, completionWithoutPayload=${completionWithoutPayload}, kinds=${kinds}`;
    throw new Error(terminalFailure
      ? `ChatGPT search stream ended with provider-declared ${terminalFailure} [${trace}]`
      : `ChatGPT search stream returned no completed response payload (cause unknown) [${trace}]`);
  }

  return completed;
}

/**
 * Join attempt errors for a thrown message, bounded: entries are individually capped at
 * ERROR_TEXT_LIMIT, but a full failover sweep (MAX_MODEL_CANDIDATES × tool types) can still
 * accumulate several KB. Keep the first two and the final attempt — the final one reflects
 * the state the sweep actually gave up in.
 */
function summarizeAttemptErrors(errors: string[]): string {
  if (errors.length <= 3) return errors.join('; ');
  const omitted = errors.length - 3;
  return [
    ...errors.slice(0, 2),
    `(+${omitted} more attempt${omitted === 1 ? '' : 's'})`,
    errors[errors.length - 1]!,
  ].join('; ');
}

function buildRequestFingerprint(body: {
  model: string;
  store: boolean;
  stream: boolean;
  tools: Array<{ type: string }>;
  tool_choice: string;
  text?: { verbosity?: string };
}): string {
  const toolType = body.tools[0]?.type || 'unknown';
  const verbosity = body.text?.verbosity || 'unset';

  return `tool=${toolType}, model=${body.model}, store=${String(body.store)}, stream=${String(body.stream)}, tool_choice=${body.tool_choice}, text.verbosity=${verbosity}`;
}

function safeParseFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  // Only messages this parser constructs can be placed in ordinary tool output.
  // An arbitrary JSON SyntaxError or SDK exception may quote raw response text.
  if (/^ChatGPT search (?:stream returned no completed response payload|stream ended with provider-declared|response parse failed: expected JSON or SSE payload|response exceeded the 2 MiB safety limit)/.test(text)) {
    return text.slice(0, ERROR_TEXT_LIMIT);
  }
  return 'unrecognized response parse failure (raw text omitted)';
}

const COMMON_CODES = new Set(['tool_unavailable', 'model_not_found', 'invalid_request_error', 'rate_limit_exceeded', 'unsupported_model']);
function safeErrorCodeTag(code: string): string {
  if (COMMON_CODES.has(code)) return code;
  // Provider-controlled codes could quote a one-word query. A plain hash can
  // be reversed by trying a small dictionary, so do not put one in the log.
  return 'code=unrecognized';
}

function safeErrorCode(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const code = parsed?.error?.code ?? parsed?.code;
    if (typeof code === 'string') return safeErrorCodeTag(code);
  } catch { /* HTTP status and request fingerprint remain available. */ }
  return 'body retained only in encrypted evidence if this search fails';
}
