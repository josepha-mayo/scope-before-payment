// Server-only. Node Functions document process.env; the platform API may also
// exist. Conflicting views or a failing accessor cannot silently select a more
// permissive profile. Never enumerate, log or expose these values.
export function runtimeEnv(name){
  const nodeValue=process.env[name],platform=globalThis.Netlify?.env;
  const platformValue=typeof platform?.get==='function'?platform.get(name):undefined;
  if(nodeValue!==undefined&&platformValue!==undefined&&nodeValue!==platformValue)throw Error('runtime_configuration_conflict');
  return nodeValue??platformValue;
}
