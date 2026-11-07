import { createHash } from 'node:crypto';
import N from '../../../experiments/scope-to-quote/nvidia-partial-request.js';
import X from '../../../experiments/scope-to-quote/partial-draft-protocol.js';

export const profile = 'anthropic-haiku-5-5-partial-v1';
export const model = 'claude-haiku-5-5';
export const sha = text => createHash('sha256').update(text).digest('hex');
// Provider grammar omits unsupported length/uniqueness constraints. The strict
// application protocol still enforces every one after generation, without repair.
function grammar(value) {
  if (Array.isArray(value)) return value.map(grammar);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['minLength','maxLength','maxItems','uniqueItems'].includes(k)).map(([k,v]) => [k,grammar(v)]));
}
export function prepareDraft(source) {
  const prepared = N.prepare(source), prompt = JSON.parse(prepared.body.messages[1].content);
  const body = { model, max_tokens: 3072, system: prepared.body.messages[0].content,
    messages: [{ role:'user', content:JSON.stringify(prompt) }],
    thinking: {type:'adaptive'}, output_config:{effort:'low',format:{type:'json_schema',schema:grammar(prompt.outputSchema)}}, stream:true };
  const request = JSON.stringify(body);
  if (Buffer.byteLength(request) > 24000) throw Error('ai_request_too_large');
  return { body, request, requestHash:sha(request),
    validate: raw => { const candidate = prepared.candidate(raw); return {candidate,review:X.resolve(candidate,source)}; } };
}
