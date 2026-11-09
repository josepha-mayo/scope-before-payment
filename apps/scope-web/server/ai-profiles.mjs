import {prepareDraft,profile,model,sha} from './ai-protocol.mjs';
import N from '../../../experiments/scope-to-quote/nvidia-partial-request.js';
import X from '../../../experiments/scope-to-quote/partial-draft-protocol.js';
import C from '../../../experiments/scope-to-quote/nvidia-demo-case.js';
import {prepareNvidiaCommissionReview} from './nvidia-request-v2.mjs';

// Persisted profile IDs select immutable request bytes and validators. A host
// change cannot reinterpret an old receipt with its newly configured model.
export const historicalNvidiaProfile='nvidia-nemotron-3-5-lightning-partial-v1';
export const nvidiaProfile='nvidia-nemotron-3-5-lightning-commission-v2';
export const nvidiaModel=C.MODEL;
const claude=Object.freeze({profile,model,prepare:prepareDraft});
const nvidia=Object.freeze({profile:historicalNvidiaProfile,model:nvidiaModel,prepare(source){
  const prepared=N.prepare(source),request=JSON.stringify(prepared.body);
  return {body:prepared.body,request,requestHash:sha(request),validate(raw){
    const candidate=prepared.candidate(raw);return {candidate,review:X.resolve(candidate,source)};
  }};
}});
const nvidiaCommission=Object.freeze({profile:nvidiaProfile,model:nvidiaModel,prepare:prepareNvidiaCommissionReview});
export function draftProtocol(id){return id===profile?claude:id===historicalNvidiaProfile?nvidia:id===nvidiaProfile?nvidiaCommission:null;}
// The original server and authored fixtures predate provider profile metadata.
// Their unchanged default remains the existing Claude profile.
export function providerProtocol(provider){return draftProtocol(provider?.profile??profile);}
