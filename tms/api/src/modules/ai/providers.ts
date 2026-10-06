/**
 * Adaptateurs officiels des fournisseurs de modèles (clé API du client, usage serveur).
 * Aucune récupération de cookies/session ChatGPT : l'accès par compte ChatGPT n'est proposé
 * que via le parcours officiel « Sign in with ChatGPT » lorsqu'il est accordé à l'éditeur.
 */
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolCalls?: ToolCall[]; name?: string }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ChatResult { text: string; toolCalls: ToolCall[]; usage: { input: number; output: number } }

export class ProviderAuthError extends Error {}
export class ProviderQuotaError extends Error {}

export interface LlmProvider {
  readonly id: 'openai' | 'gemini' | 'mistral' | 'fake';
  chat(req: { apiKey: string; model: string; messages: ChatMessage[]; tools: ToolDef[]; maxTokens: number; signal?: AbortSignal }): Promise<ChatResult>;
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(60000) });
  const json: any = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new ProviderAuthError(json?.error?.message ?? 'Clé refusée par le fournisseur');
  if (res.status === 429) throw new ProviderQuotaError(json?.error?.message ?? 'Quota fournisseur atteint');
  if (!res.ok) throw new Error(`Fournisseur ${res.status} : ${json?.error?.message ?? 'erreur'}`);
  return json;
}

export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai' as const;
  async chat({ apiKey, model, messages, tools, maxTokens, signal }: Parameters<LlmProvider['chat']>[0]): Promise<ChatResult> {
    const json = await post('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${apiKey}` }, {
      model, max_completion_tokens: maxTokens,
      messages: messages.map((m) => m.role === 'tool' ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
        : m.toolCalls?.length ? { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) }
          : { role: m.role, content: m.content }),
      tools: tools.length ? tools.map((t) => ({ type: 'function', function: t })) : undefined,
    }, signal);
    const msg = json.choices?.[0]?.message ?? {};
    return {
      text: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((t: any) => ({ id: t.id, name: t.function.name, args: safeJson(t.function.arguments) })),
      usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 },
    };
  }
}

export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini' as const;
  async chat({ apiKey, model, messages, tools, maxTokens, signal }: Parameters<LlmProvider['chat']>[0]): Promise<ChatResult> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages.filter((m) => m.role !== 'system').map((m) => m.role === 'tool'
      ? { role: 'user', parts: [{ functionResponse: { name: m.name, response: { content: safeJson(m.content) } } }] }
      : m.toolCalls?.length ? { role: 'model', parts: m.toolCalls.map((t) => ({ functionCall: { name: t.name, args: t.args } })) }
        : { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
    const json = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': apiKey }, {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents,
      tools: tools.length ? [{ functionDeclarations: tools }] : undefined, generationConfig: { maxOutputTokens: maxTokens },
    }, signal);
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    return {
      text: parts.filter((p: any) => p.text).map((p: any) => p.text).join(''),
      toolCalls: parts.filter((p: any) => p.functionCall).map((p: any, i: number) => ({ id: `g${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {} })),
      usage: { input: json.usageMetadata?.promptTokenCount ?? 0, output: json.usageMetadata?.candidatesTokenCount ?? 0 },
    };
  }
}

/** Fournisseur simulé déterministe (tests et démonstration hors ligne). */
export class FakeLlmProvider implements LlmProvider {
  readonly id = 'fake' as const;
  async chat({ apiKey, messages }: Parameters<LlmProvider['chat']>[0]): Promise<ChatResult> {
    if (apiKey.startsWith('revoked')) throw new ProviderAuthError('Clé révoquée');
    const last = messages[messages.length - 1];
    const usage = { input: 100, output: 20 };
    if (last.role === 'tool') return { text: `Voici le résultat (source : ${last.name}) : ${last.content.slice(0, 400)}`, toolCalls: [], usage };
    const q = last.content.toLowerCase();
    if (/\bca\b|chiffre d'affaires/.test(q)) return { text: '', toolCalls: [{ id: 't1', name: 'get_metrics', args: { metric: 'revenue_net_ht', from: `${new Date().getFullYear()}-01-01`, to: `${new Date().getFullYear()}-12-31`, granularity: 'year' } }], usage };
    if (q.includes('session') && q.includes('prépare')) return { text: '', toolCalls: [{ id: 't2', name: 'propose_session', args: JSON.parse(/\{.*\}/.exec(last.content)?.[0] ?? '{}') }], usage };
    if (q.includes('sessions')) return { text: '', toolCalls: [{ id: 't3', name: 'search_sessions', args: {} }], usage };
    if (q.includes('email')) return { text: '', toolCalls: [{ id: 't4', name: 'propose_email', args: JSON.parse(/\{.*\}/.exec(last.content)?.[0] ?? '{}') }], usage };
    return { text: 'Je peux rechercher vos sessions, calculer vos indicateurs ou préparer un brouillon.', toolCalls: [], usage };
  }
}

export function safeJson(s: string): any { try { return JSON.parse(s); } catch { return {}; } }

/** Coûts indicatifs (centimes / million de tokens) — estimation affichée comme telle. */
export const PRICE_ESTIMATES: Record<string, { in: number; out: number }> = {
  'gpt-4.1-mini': { in: 40, out: 160 }, 'gpt-4.1': { in: 200, out: 800 }, 'gpt-4o-mini': { in: 15, out: 60 },
  'gemini-2.5-flash': { in: 30, out: 250 }, 'gemini-2.5-pro': { in: 125, out: 1000 },
};
