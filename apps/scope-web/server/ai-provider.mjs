import Anthropic from '@anthropic-ai/sdk';
import { model,profile } from './ai-protocol.mjs';

// No key is read during build or returned to the browser. Fail closed if a
// project override would bypass the disclosed Netlify gateway route.
export function gatewayAvailable(env = process.env) {
  try {
    if (!env.ANTHROPIC_API_KEY) return false;
    const base = new URL(env.ANTHROPIC_BASE_URL), gateway = new URL(env.NETLIFY_AI_GATEWAY_URL);
    const clean = u => u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
    return clean(base) && clean(gateway) && base.origin === gateway.origin &&
      (base.pathname === gateway.pathname || base.pathname.startsWith(gateway.pathname.replace(/\/$/,'')+'/'));
  } catch { return false; }
}
export function createDraftProvider({ available = gatewayAvailable, client = () => new Anthropic({maxRetries:0,timeout:25000}) } = {}) {
  return Object.freeze({
    profile,
    available,
    async generate(body) {
      if (!available()) throw Error('ai_unavailable');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(),25000);
      let raw='', complete=false, stopReason=null, returnedModel=null, inputTokens=null, outputTokens=null;
      try {
        const stream = await client().messages.create(body,{signal:controller.signal,maxRetries:0});
        for await (const event of stream) {
          if (event.type === 'message_start') { returnedModel=event.message.model;inputTokens=event.message.usage?.input_tokens; }
          if (event.type === 'content_block_start' && !['text','thinking','redacted_thinking'].includes(event.content_block.type)) throw Error('ai_output_invalid');
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            raw += event.delta.text;
            if (Buffer.byteLength(raw)>16384) throw Error('ai_output_too_large');
          }
          if (event.type === 'message_delta') { stopReason=event.delta.stop_reason;outputTokens=event.usage?.output_tokens; }
          if (event.type === 'message_stop') complete=true;
        }
        if (!complete || returnedModel !== model || stopReason !== 'end_turn') return {state:'invalid',raw,code:'ai_output_incomplete'};
        const token = n => Number.isSafeInteger(n) && n>=0 && n<=1000000 ? n : null;
        return {state:'received',raw,usage:{inputTokens:token(inputTokens),outputTokens:token(outputTokens)}};
      } catch {
        // An SDK/network failure cannot prove that the provider did no work.
        return {state:'unconfirmed',raw,code:'ai_provider_unconfirmed'};
      } finally { clearTimeout(timer);controller.abort(); }
    },
  });
}
