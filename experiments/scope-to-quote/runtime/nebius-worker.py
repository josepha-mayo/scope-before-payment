"""One admitted synthetic draft. Inert on import; no credentials in arguments/output.
Deployment packet/admission + supervisor source must be independently pinned.
No retry. Uncertain POSTs retain their full reservation. stdlib only.
"""
import hashlib
import json
import os
import pathlib
import re
import signal
import stat
import sys
import time
import urllib.error
import urllib.request

CAP = 5_000_000_000
RESERVE = 20_889_600
ENDPOINT = 'https://api.tokenfactory.nebius.com/v1/chat/completions'
MODEL = 'openai/gpt-oss-120b'
FIELDS = ['deliverable', 'usage', 'delivery', 'revisions', 'price', 'terms']


def encoded(x):
    return json.dumps(x, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(b):
    return hashlib.sha256(b).hexdigest()


def exact(x, keys):
    return type(x) is dict and set(x) == set(keys)


def private_dir(p):
    p = pathlib.Path(p)
    s = p.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077 or p.resolve() != p:
        raise ValueError('private_directory')
    return p


def read(p, limit=131072):
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        s = os.fstat(f.fileno())
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077 or s.st_nlink != 1 or s.st_size > limit:
            raise ValueError('private_file')
        b = f.read(limit + 1)
    if len(b) > limit:
        raise ValueError('private_file')
    return b


def write(p, x, replace=False):
    """Owned worker alone writes budget; a failed commit is never retried."""
    p = pathlib.Path(p)
    target = p.with_name(p.name + '.pending') if replace else p
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(encoded(x))
        f.flush()
        os.fsync(f.fileno())
    if replace:
        os.replace(target, p)
    fd = os.open(p.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def text(s, maximum):
    if type(s) is not str or not s.strip() or len(s.encode('utf-16-le')) // 2 > maximum:
        return False
    return not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]', s)


def candidate(x, source):
    if not exact(x, ['fields', 'questions']) or not exact(x['fields'], FIELDS):
        raise ValueError('candidate')
    def refs(rs):
        if type(rs) is not list or not 1 <= len(rs) <= 4:
            raise ValueError('references')
        seen = set()
        for r in rs:
            if not exact(r, ['messageId', 'quote']) or not text(r['quote'], 600) or not any(m['id'] == r['messageId'] and r['quote'] in m['text'] for m in source['messages']):
                raise ValueError('references')
            key = (r['messageId'], r['quote'])
            if key in seen:
                raise ValueError('references')
            seen.add(key)
    for k in FIELDS:
        v = x['fields'][k]
        if k == 'price':
            if not exact(v, ['totalCents', 'currency', 'refs']) or type(v['totalCents']) is not int or not 1 <= v['totalCents'] <= 1_000_000 or v['currency'] != 'USD':
                raise ValueError('candidate')
        elif not exact(v, ['text', 'refs']) or not text(v['text'], 700):
            raise ValueError('candidate')
        refs(v['refs'])
    if type(x['questions']) is not list or len(x['questions']) > 6:
        raise ValueError('questions')
    seen = set()
    for q in x['questions']:
        if not exact(q, ['field', 'question', 'refs']) or q['field'] not in FIELDS or q['field'] in seen or not text(q['question'], 300):
            raise ValueError('questions')
        seen.add(q['field'])
        refs(q['refs'])
    return x


def span_index(source, version, binding):
    spans = []
    for m in source['messages']:
        raw = m['text'].encode('utf-16-le')
        start = 0
        while start < len(raw) // 2:
            end = min(start + 200, len(raw) // 2)
            if end < len(raw) // 2 and 0xD800 <= int.from_bytes(raw[(end-1)*2:end*2], 'little') <= 0xDBFF:
                end -= 1
            spans.append({'id': 's' + str(version) + '_' + binding + '_' + m['id'] + '_' + str(start) + '_' + str(end), 'messageId': m['id'], 'role': m['role'], 'start': start, 'end': end, 'quote': raw[start*2:end*2].decode('utf-16-le'), 'partialMessage': start > 0 or end < len(raw)//2})
            start = end
    if len(spans) > 64 or len(source['messages']) > 8 or sum(len(m['text'].encode('utf-16-le'))//2 for m in source['messages']) > 5000:
        raise ValueError('span_bound')
    return {'kind': 'scope_source_spans_v1', 'sourceVersion': version, 'sourceBinding': binding, 'spans': spans}


def span_candidate(x, source, version, binding):
    ix = span_index(source, version, binding)
    allowed = {v['id'] for v in ix['spans']}
    if not exact(x, ['kind', 'sourceVersion', 'sourceBinding', 'fields', 'exclusions', 'questions']) or x['kind'] != 'source_span_draft_v1' or type(x['sourceVersion']) is not int or x['sourceVersion'] != version or x['sourceBinding'] != binding or not exact(x['fields'], FIELDS):
        raise ValueError('span_candidate')
    def ids(xs):
        if type(xs) is not list or not 1 <= len(xs) <= 4 or any(type(v) is not str or v not in allowed for v in xs) or len(set(xs)) != len(xs):
            raise ValueError('span_references')
    for k in FIELDS:
        v = x['fields'][k]
        if k == 'price':
            if not exact(v, ['totalCents', 'currency', 'spanIds']) or type(v['totalCents']) is not int or not 1 <= v['totalCents'] <= 1000000 or v['currency'] != 'USD':
                raise ValueError('span_candidate')
        elif not exact(v, ['text', 'spanIds']) or not text(v['text'], 700):
            raise ValueError('span_candidate')
        ids(v['spanIds'])
    e = x['exclusions']
    if not exact(e, ['state', 'text', 'spanIds']):
        raise ValueError('span_exclusions')
    if e['state'] == 'proposed' and text(e['text'], 500):
        ids(e['spanIds'])
    elif not (e['state'] == 'none_found' and e['text'] == '' and type(e['spanIds']) is list and not e['spanIds']):
        raise ValueError('span_exclusions')
    if type(x['questions']) is not list or len(x['questions']) > 6:
        raise ValueError('span_questions')
    seen = set()
    for q in x['questions']:
        if not exact(q, ['field', 'question', 'spanIds']) or type(q['field']) is not str or q['field'] not in FIELDS + ['exclusions'] or q['field'] in seen or not text(q['question'], 300):
            raise ValueError('span_questions')
        seen.add(q['field'])
        ids(q['spanIds'])
    return x


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('redirect')


def exchange(body, key, remaining):
    req = urllib.request.Request(ENDPOINT, body, {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key}, method='POST')
    # Platform proxy/CA configuration is inherited; no TLS override or alternate route.
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(req, timeout=min(90, remaining))
    except urllib.error.HTTPError as error:
        response = error
    with response:
        status = response.status
        chunks, size = [], 0
        for _ in range(1024):
            part = response.read(min(65536, 3 * 1024 * 1024 - size + 1))
            if not part:
                break
            size += len(part)
            if size > 3 * 1024 * 1024:
                raise ValueError('response_bound')
            chunks.append(bytes(part))
        else:
            raise ValueError('response_chunks')
    raw = b''.join(chunks)
    if key.encode() in raw:
        raise ValueError('credential_echo')
    return status, json.loads(raw.decode('utf-8', errors='strict'))


def run(packet_dir, case_dir, *, key_loader=None, fetch=None, clock=time.monotonic):
    """Injection is for authored tests. CLI supplies only the fixed implementation."""
    packet, case = private_dir(packet_dir), private_dir(case_dir)
    ledger = private_dir(case.parent.parent)
    started = clock()
    post_started = settled = poisoned = False
    stage = 'preflight'
    def ensure():
        if clock() - started >= 90:
            raise ValueError('deadline')
    def load_key():
        # Trusted future deployment must pin an explicitly authorized private file.
        # No discovery, environment fallback or key creation is supported.
        c = manifest.get('credentialSource')
        if not exact(c, ['kind', 'path', 'sha256']) or c['kind'] != 'owned_private_nebius_key_file' or type(c['path']) is not str or not pathlib.Path(c['path']).is_absolute() or pathlib.Path(c['path']).resolve() != pathlib.Path(c['path']) or not re.fullmatch(r'[a-f0-9]{64}', c['sha256']):
            raise ValueError('credential_unavailable')
        raw = read(pathlib.Path(c['path']), 8192)
        if digest(raw) != c['sha256']:
            raise ValueError('credential_unavailable')
        value = json.loads(raw)
        if not exact(value, ['apiKey']):
            raise ValueError('credential_unavailable')
        key = value['apiKey']
        if type(key) is not str or not 16 <= len(key) <= 4096 or any(ord(c) <= 32 or ord(c) >= 127 for c in key):
            raise ValueError('credential_unavailable')
        return key
    try:
        permit = json.loads(read(case / 'permit.json'))
        manifest_bytes = read(packet / 'manifest.json')
        admission_bytes = read(packet / 'admission.json')
        if permit['packetSHA256'] != digest(manifest_bytes) or permit['admissionSHA256'] != digest(admission_bytes):
            raise ValueError('packet')
        manifest, admission = json.loads(manifest_bytes), json.loads(admission_bytes)
        blobs = {name: read(packet / name) for name in manifest['files'] if re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,79}', name)}
        if len(blobs) != len(manifest['files']) or any(digest(b) != manifest['files'][n] for n, b in blobs.items()):
            raise ValueError('packet')
        body = json.loads(blobs['body.json'])
        source, seed = json.loads(blobs['source.json']), json.loads(blobs['predecessor-seal.json'])
        # Node validates exact body/schema/source/lineage first. Worker independently
        # binds its exact bytes and conservative budget before any key access.
        if admission.get('rootReviewed') is not True or admission.get('humanApprovalVerified') is not True or admission.get('syntheticOnly') is not True or admission.get('maximumNanoUSD') != CAP or admission.get('maximumCalls') != 1 or admission.get('endpoint') != ENDPOINT or admission.get('model') != MODEL or admission.get('manifestSHA256') != digest(manifest_bytes) or admission.get('bodySHA256') != digest(encoded(body)) or permit.get('bodySHA256') != digest(encoded(body)) or permit.get('sourceBinding') != digest(encoded(source['messages'])) or admission.get('sourceBinding') != permit['sourceBinding'] or admission.get('sourceVersion') != 1 or body.get('model') != MODEL or body.get('max_completion_tokens') != 2048 or body.get('stream') is not False or len(blobs['body.json']) > 16384:
            raise ValueError('admission')
        span_mode = admission.get('draftFormat') == 'source_spans_v1'
        if admission.get('draftFormat') not in (None, 'source_spans_v1'):
            raise ValueError('draft_format')
        if span_mode:
            user = json.loads(body['messages'][1]['content'])
            if not exact(user, ['task', 'messages', 'outputSchema', 'spanIndex']) or encoded(user['messages']) != encoded(source['messages']) or encoded(user['spanIndex']) != encoded(span_index(source, 1, permit['sourceBinding'])):
                raise ValueError('span_source')
        spent = seed.get('spentNanoUSD')
        if type(spent) is not int or not 0 <= spent <= CAP or spent + RESERVE > CAP:
            raise ValueError('budget')
        budget = {'schema': 1, 'seedSHA256': digest(blobs['predecessor-seal.json']), 'spentNanoUSD': spent + RESERVE, 'stopped': True, 'records': [{'id': case.name, 'sourceBinding': permit['sourceBinding'], 'bodySHA256': permit['bodySHA256'], 'admissionSHA256': permit['admissionSHA256'], 'state': 'reserved', 'costNanoUSD': RESERVE, 'responseSHA256': None, 'usageSHA256': None}]}
        # A budget file already present means this exact ledger is consumed.
        try:
            write(ledger / 'budget.json', budget)
        except Exception:
            poisoned = True
            raise
        ensure()
        stage = 'credentials'
        key = (key_loader or load_key)()
        ensure()
        stage = 'possible_post'
        budget['records'][0]['state'] = 'possible'
        budget['spentNanoUSD'] = spent + RESERVE
        try:
            write(ledger / 'budget.json', budget, replace=True)
        except Exception:
            poisoned = True
            raise
        post_started = True
        ensure()
        status, response = (fetch or exchange)(encoded(body), key, max(0.001, 90 - (clock() - started)))
        ensure()
        # Do not persist an unbounded/secret-bearing injected response either.
        raw = encoded(response)
        if len(raw) > 3 * 1024 * 1024 or key.encode() in raw:
            raise ValueError('response_bound')
        usage = response.get('usage') if type(response) is dict else None
        if type(status) is not int or status != 200 or response.get('model') != MODEL or type(usage) is not dict or type(usage.get('prompt_tokens')) is not int or type(usage.get('completion_tokens')) is not int or not 0 <= usage['prompt_tokens'] <= 131072 or not 0 <= usage['completion_tokens'] <= 2048 or ('total_tokens' in usage and type(usage['total_tokens']) is not int) or usage.get('total_tokens', usage['prompt_tokens'] + usage['completion_tokens']) != usage['prompt_tokens'] + usage['completion_tokens']:
            raise ValueError('usage_unconfirmed')
        u = {'promptTokens': usage['prompt_tokens'], 'completionTokensIncludingReasoning': usage['completion_tokens'], 'estimatedNanoUSD': usage['prompt_tokens'] * 150 + usage['completion_tokens'] * 600}
        write(case / 'response.json', {'status': status, 'response': response})
        write(case / 'usage.json', u)
        budget['spentNanoUSD'] = spent + u['estimatedNanoUSD']
        budget['records'][0].update(state='completed', costNanoUSD=u['estimatedNanoUSD'], responseSHA256=digest(read(case / 'response.json', 3 * 1024 * 1024)), usageSHA256=digest(read(case / 'usage.json')))
        try:
            write(ledger / 'budget.json', budget, replace=True)
        except Exception:
            poisoned = True
            raise
        settled = True
        stage = 'protocol_validation'
        ensure()
        choices = response.get('choices')
        if type(choices) is not list or len(choices) != 1 or choices[0].get('finish_reason') != 'stop' or type(choices[0].get('message', {}).get('content')) is not str:
            raise ValueError('protocol')
        result = span_candidate(json.loads(choices[0]['message']['content']), source, 1, permit['sourceBinding']) if span_mode else candidate(json.loads(choices[0]['message']['content']), source)
        write(case / 'candidate.json', result)
        ensure()
        write(case / 'terminal.json', {'ok': True, 'postStarted': True, 'usageSettled': True, 'bodySHA256': permit['bodySHA256'], 'sourceBinding': permit['sourceBinding'], 'estimatedNanoUSD': u['estimatedNanoUSD'], 'candidateSHA256': digest(read(case / 'candidate.json')), 'responseSHA256': digest(read(case / 'response.json', 3 * 1024 * 1024)), 'usageSHA256': digest(read(case / 'usage.json'))})
        return 0
    except BaseException:
        # No retry or cleanup of a durable consumed fence. Fixed labels only.
        try:
            write(case / 'worker-exit.json', {'stage': stage, 'postStarted': post_started, 'usageSettled': settled, 'writerPoisoned': poisoned, 'unknownReservationNanoUSD': RESERVE if post_started and not settled else 0, 'noRetry': True})
        except Exception:
            pass
        return 1


if __name__ == '__main__':
    def stop(*_):
        raise InterruptedError('retired')
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGALRM, stop)
    signal.setitimer(signal.ITIMER_REAL, 90)
    # Deployment must separately review and explicitly authorize the exact pinned
    # credential file. No credential or live configuration is supplied here.
    if len(sys.argv) != 3:
        sys.exit(1)
    sys.exit(run(sys.argv[1], sys.argv[2]))
