import {startPortableRuntime} from './runtime.mjs';

if(process.argv.length!==2)throw Error('usage_npm_run_start_portable_no_arguments');
let runtime,closing=false;
async function stop(){if(closing)return;closing=true;try{await runtime?.close();}catch{process.exitCode=1;}}
try{
  runtime=await startPortableRuntime();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  console.log(JSON.stringify({kind:'scope_portable_runtime_v1',status:'listening',mode:'read-only',aiEnabled:false,paypalEnabled:false}));
}catch(error){const code=['runtime_build_failed','runtime_schema_failed','runtime_listen_failed','runtime_tls_required','runtime_database_required','runtime_database_invalid','runtime_database_tls_required','runtime_database_ca_invalid','runtime_port_invalid','runtime_legacy_mapping_required','auth_origin_required','auth_origin_invalid','auth_secret_required','auth_epoch_required','auth_provider_required'].find(value=>value===(error?.code??error?.message))??'runtime_configuration_unavailable';console.error(JSON.stringify({kind:'scope_portable_runtime_v1',status:'unavailable',code}));process.exitCode=1;}
