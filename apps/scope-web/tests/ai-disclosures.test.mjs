import test from 'node:test';
import assert from 'node:assert/strict';
import {profile,model} from '../server/ai-protocol.mjs';
import {nvidiaProfile,nvidiaModel} from '../server/ai-profiles.mjs';
import {aiProviderDisclosure} from '../src/ai-disclosures.mjs';

test('browser disclosures match the immutable server profiles and reject an unknown or mismatched recipient',()=>{
  const claude=aiProviderDisclosure(profile,model),nvidia=aiProviderDisclosure(nvidiaProfile,nvidiaModel);
  assert.equal(claude.profile,profile);assert.match(claude.consent,/to Anthropic through Netlify/);
  assert.equal(nvidia.profile,nvidiaProfile);assert.match(nvidia.consent,/to NVIDIA/);assert.doesNotMatch(nvidia.consent,/Anthropic|Netlify/);
  for(const pair of [[profile,nvidiaModel],[nvidiaProfile,model],['future-profile',model],[undefined,model],['__proto__',undefined]])assert.equal(aiProviderDisclosure(...pair),null);
  assert.ok(Object.isFrozen(claude));assert.ok(Object.isFrozen(nvidia));
});
