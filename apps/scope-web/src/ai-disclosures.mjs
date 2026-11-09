const claude=Object.freeze({profile:'anthropic-haiku-5-5-partial-v1',model:'claude-haiku-5-5',name:'Claude Haiku 5.5',
  consent:'Send excerpts from this saved conversation to Anthropic through Netlify for AI review. Scope privately retains this request and its result.',
  dataUseText:'Claude Haiku 5.5 through Netlify AI Gateway. Saved conversation excerpts are sent to Anthropic only when you explicitly request AI review. Scope privately retains the request and result.'});
const nvidia=Object.freeze({profile:'nvidia-nemotron-3-5-lightning-partial-v1',model:'nvidia/nemotron-3.5-lightning-30b-a3b',name:'NVIDIA Nemotron 3.5 Lightning',
  consent:'Send excerpts from this saved conversation to NVIDIA for AI review. Scope privately retains this request and its result.',
  dataUseText:'NVIDIA Nemotron 3.5 Lightning. Saved conversation excerpts are sent to NVIDIA only when you explicitly request AI review. Scope privately retains the request and result.'});
export function aiProviderDisclosure(profile,model){
  const known=profile===claude.profile?claude:profile===nvidia.profile?nvidia:null;
  return known?.model===model?known:null;
}
