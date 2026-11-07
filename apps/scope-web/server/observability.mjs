// Minimal correlation metadata in the existing hosting platform's function log.
// Never pass Request, Context, URL, headers, body, actor IDs or provider output.
export function createRequestReporter({write=line=>console.info(line)}={}){
  return event=>{try{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(event.traceId)||!Number.isInteger(event.status)||event.status<200||event.status>599)return;
    const entry={kind:'scope_request_v1',traceId:event.traceId,
      ...(/^[A-Za-z0-9_-]{12,128}$/.test(event.platformRequestId||'')?{platformRequestId:event.platformRequestId}:{}),
      action:/^[a-z][a-z_/-]{0,47}$/.test(event.action||'')?event.action:'unknown',
      method:['GET','POST','HEAD','PUT','PATCH','DELETE','OPTIONS'].includes(event.method)?event.method:'OTHER',
      status:event.status,code:/^[a-z][a-z0-9_]{0,79}$/.test(event.code||'')?event.code:'unclassified',
      durationMs:Number.isFinite(event.durationMs)?Math.min(3600000,Math.max(0,Math.round(event.durationMs))):0};
    write(JSON.stringify(entry));
  }catch{/* Telemetry must never change or replay an application outcome. */}};
}
