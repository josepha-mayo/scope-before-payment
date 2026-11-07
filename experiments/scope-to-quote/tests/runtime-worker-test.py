"""Authored fake response/key-loader tests; no network or real credentials."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

RUNTIME = pathlib.Path(__file__).resolve().parent.parent / 'runtime'
spec = importlib.util.spec_from_file_location('worker', RUNTIME / 'nebius-worker.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class WorkerTest(unittest.TestCase):
    def fixture(self, *, spent=0, mutate=None):
        tmp = tempfile.TemporaryDirectory(prefix='nebius-authored-worker-')
        self.addCleanup(tmp.cleanup)
        root = pathlib.Path(tmp.name)
        packet, ledger = root / 'packet', root / 'ledger'
        for p in [packet, ledger, ledger / 'cases', ledger / 'cases' / 'authored-case']:
            p.mkdir(mode=0o700)
        case = ledger / 'cases' / 'authored-case'
        messages = [{'id': 'B1', 'role': 'buyer', 'text': 'Invented buyer scope.'}, {'id': 'M1', 'role': 'merchant', 'text': 'Invented merchant scope.'}]
        body = {'model': w.MODEL, 'messages': [{'role': 'system', 'content': 'Invented instructions'}, {'role': 'user', 'content': json.dumps({'messages': messages})}], 'max_completion_tokens': 2048, 'stream': False}
        values = {'body.json': body, 'source.json': {'messages': messages}, 'predecessor-seal.json': {'spentNanoUSD': spent}}
        if mutate:
            mutate(values)
        blobs = {n: w.encoded(x) for n, x in values.items()}
        manifest = {'files': {n: w.digest(b) for n, b in blobs.items()}}
        mb = w.encoded(manifest)
        admission = {'rootReviewed': True, 'humanApprovalVerified': True, 'syntheticOnly': True, 'maximumNanoUSD': w.CAP, 'maximumCalls': 1, 'endpoint': w.ENDPOINT, 'model': w.MODEL, 'manifestSHA256': w.digest(mb), 'bodySHA256': w.digest(blobs['body.json']), 'sourceBinding': w.digest(w.encoded(messages)), 'sourceVersion': 1}
        ab = w.encoded(admission)
        for n, b in {**blobs, 'manifest.json': mb, 'admission.json': ab}.items():
            (packet / n).write_bytes(b)
            (packet / n).chmod(0o600)
        w.write(case / 'permit.json', {'packetSHA256': w.digest(mb), 'admissionSHA256': w.digest(ab), 'sourceBinding': admission['sourceBinding'], 'bodySHA256': admission['bodySHA256']})
        ref = [{'messageId': 'M1', 'quote': messages[1]['text']}]
        candidate = {'fields': {k: ({'totalCents': 12000, 'currency': 'USD', 'refs': ref} if k == 'price' else {'text': 'Invented ' + k, 'refs': ref}) for k in w.FIELDS}, 'questions': []}
        response = {'model': w.MODEL, 'usage': {'prompt_tokens': 100, 'completion_tokens': 200, 'total_tokens': 300}, 'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(candidate)}}]}
        return packet, case, ledger, response

    def test_valid_candidate_and_exact_settled_cost(self):
        p, c, ledger, response = self.fixture()
        calls = []
        def key():
            budget = json.loads((ledger / 'budget.json').read_bytes())
            self.assertEqual(budget['spentNanoUSD'], w.RESERVE)
            calls.append('key')
            return 'AUTHORED_NOT_A_REAL_KEY_123'
        def fetch(body, secret, remaining):
            self.assertEqual(json.loads((ledger / 'budget.json').read_bytes())['records'][0]['state'], 'possible')
            calls.append('post')
            return 200, response
        self.assertEqual(w.run(p, c, key_loader=key, fetch=fetch), 0)
        self.assertEqual(calls, ['key', 'post'])
        budget = json.loads((ledger / 'budget.json').read_bytes())
        self.assertEqual(budget['spentNanoUSD'], 135000)
        self.assertEqual(budget['records'][0]['state'], 'completed')
        self.assertTrue((c / 'terminal.json').exists())

    def test_prior_unknown_full_grant_never_loads_key(self):
        p, c, ledger, _ = self.fixture(spent=w.CAP)
        self.assertEqual(w.run(p, c, key_loader=lambda: self.fail('key accessed'), fetch=lambda *_: self.fail('network')), 1)
        self.assertFalse((ledger / 'budget.json').exists())

    def test_missing_admission_no_key(self):
        p, c, _, _ = self.fixture()
        (p / 'admission.json').unlink()
        self.assertEqual(w.run(p, c, key_loader=lambda: self.fail('key accessed')), 1)

    def test_lost_response_reserves_full_cost_never_retries(self):
        p, c, ledger, _ = self.fixture()
        calls = []
        def fetch(*_):
            calls.append(1)
            raise RuntimeError('AUTHORED_SECRET_INTERNAL_FAILURE')
        self.assertEqual(w.run(p, c, key_loader=lambda: 'AUTHORED_NOT_A_REAL_KEY_123', fetch=fetch), 1)
        self.assertEqual(w.run(p, c, key_loader=lambda: self.fail('second key'), fetch=fetch), 1)
        self.assertEqual(len(calls), 1)
        budget = json.loads((ledger / 'budget.json').read_bytes())
        self.assertEqual(budget['spentNanoUSD'], w.RESERVE)
        self.assertEqual(budget['records'][0]['state'], 'possible')
        self.assertNotIn('SECRET', (c / 'worker-exit.json').read_text())

    def test_noncontiguous_citation_is_settled_rejection(self):
        p, c, ledger, response = self.fixture()
        value = json.loads(response['choices'][0]['message']['content'])
        value['fields']['terms']['refs'][0]['quote'] = 'Invented ... scope.'
        response['choices'][0]['message']['content'] = json.dumps(value)
        self.assertEqual(w.run(p, c, key_loader=lambda: 'AUTHORED_NOT_A_REAL_KEY_123', fetch=lambda *_: (200, response)), 1)
        failure = json.loads((c / 'worker-exit.json').read_bytes())
        self.assertEqual(failure['stage'], 'protocol_validation')
        self.assertTrue(failure['usageSettled'])
        self.assertFalse((c / 'candidate.json').exists())
        self.assertEqual(json.loads((ledger / 'budget.json').read_bytes())['spentNanoUSD'], 135000)

    def test_bad_usage_retains_unknown_reservation(self):
        for bad in [True, -1, 2049, '200']:
            p, c, ledger, response = self.fixture()
            response['usage']['completion_tokens'] = bad
            self.assertEqual(w.run(p, c, key_loader=lambda: 'AUTHORED_NOT_A_REAL_KEY_123', fetch=lambda *_: (200, response)), 1)
            self.assertEqual(json.loads((ledger / 'budget.json').read_bytes())['spentNanoUSD'], w.RESERVE)
            self.assertFalse((c / 'response.json').exists())

    def test_secret_echo_not_persisted(self):
        p, c, _, response = self.fixture()
        response['debug'] = 'AUTHORED_NOT_A_REAL_KEY_123'
        self.assertEqual(w.run(p, c, key_loader=lambda: response['debug'], fetch=lambda *_: (200, response)), 1)
        self.assertFalse((c / 'response.json').exists())

    def test_late_response_not_persisted(self):
        p, c, _, response = self.fixture()
        now = [0]
        def fetch(*_):
            now[0] = 91
            return 200, response
        self.assertEqual(w.run(p, c, key_loader=lambda: 'AUTHORED_NOT_A_REAL_KEY_123', fetch=fetch, clock=lambda: now[0]), 1)
        self.assertFalse((c / 'candidate.json').exists())
        self.assertFalse((c / 'response.json').exists())

    def test_settlement_commit_uncertainty_stays_poisoned_no_candidate(self):
        p, c, ledger, response = self.fixture()
        original = w.write
        saves = [0]
        def write(file, value, replace=False):
            if pathlib.Path(file) == ledger / 'budget.json':
                saves[0] += 1
                if saves[0] == 3:
                    raise OSError('AUTHORED_PRIVATE_COMMIT_ERROR')
            return original(file, value, replace)
        w.write = write
        try:
            self.assertEqual(w.run(p, c, key_loader=lambda: 'AUTHORED_NOT_A_REAL_KEY_123', fetch=lambda *_: (200, response)), 1)
        finally:
            w.write = original
        failure = json.loads((c / 'worker-exit.json').read_bytes())
        self.assertTrue(failure['writerPoisoned'])
        self.assertFalse(failure['usageSettled'])
        self.assertFalse((c / 'candidate.json').exists())
        self.assertEqual(json.loads((ledger / 'budget.json').read_bytes())['spentNanoUSD'], w.RESERVE)
        self.assertEqual(saves[0], 3)

    def test_fake_bounded_exchange_rejects_redirect_and_oversize_without_network(self):
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, maximum): return b' ' * maximum
        class Opener:
            def open(self, *_args, **_kwargs): return Response()
        original = w.urllib.request.build_opener
        w.urllib.request.build_opener = lambda *_: Opener()
        try:
            with self.assertRaisesRegex(ValueError, 'response_bound'):
                w.exchange(b'{}', 'AUTHORED_NOT_A_REAL_KEY_123', 1)
        finally:
            w.urllib.request.build_opener = original
        with self.assertRaisesRegex(ValueError, 'redirect'):
            w.NoRedirect().redirect_request(None, None, 302, None, None, 'https://authored.invalid/')

    def test_missing_pinned_credential_source_stops_before_fetch(self):
        p, c, ledger, _ = self.fixture()
        self.assertEqual(w.run(p, c, fetch=lambda *_: self.fail('network')), 1)
        failure = json.loads((c / 'worker-exit.json').read_bytes())
        self.assertFalse(failure['postStarted'])
        self.assertEqual(failure['stage'], 'credentials')
        self.assertEqual(json.loads((ledger / 'budget.json').read_bytes())['spentNanoUSD'], w.RESERVE)

    def test_import_inert_and_cli_missing_arguments(self):
        out = subprocess.run([sys.executable, str(RUNTIME / 'nebius-worker.py')], capture_output=True, timeout=2)
        self.assertEqual(out.returncode, 1)
        self.assertEqual(out.stdout + out.stderr, b'')

    def supervisor(self, code, timeout=1, limit=100):
        tmp = tempfile.TemporaryDirectory(prefix='nebius-authored-supervisor-')
        self.addCleanup(tmp.cleanup)
        root = pathlib.Path(tmp.name)
        process = subprocess.run([sys.executable, str(RUNTIME / 'nebius-supervisor.py'), '--run-dir', str(root / 'receipt'), '--cwd', str(root), '--timeout', str(timeout), '--grace', '.05', '--max-output-bytes', str(limit), '--', sys.executable, '-c', code], capture_output=True, timeout=4)
        return process, json.loads((root / 'receipt' / 'receipt.json').read_bytes())

    def test_supervisor_success_redacts_child_output(self):
        p, r = self.supervisor("print('AUTHORED_PRIVATE_OUTPUT')")
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout + p.stderr, b'')
        self.assertEqual(r, {'terminal': True, 'state': 'finished', 'childReturnCode': 0, 'outputComplete': True, 'receivedSignal': None})

    def test_supervisor_timeout_reaps(self):
        p, r = self.supervisor('import time;time.sleep(60)', timeout=.05)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(r['state'], 'timeout')
        self.assertNotEqual(r['childReturnCode'], 0)

    def test_supervisor_active_retirement_reaps_owned_child(self):
        import time
        tmp = tempfile.TemporaryDirectory(prefix='nebius-authored-retire-')
        self.addCleanup(tmp.cleanup)
        root = pathlib.Path(tmp.name)
        marker = root / 'child.json'
        code = "import os,time,pathlib;pathlib.Path(" + repr(str(marker)) + ").write_text(str(os.getpid()));time.sleep(60)"
        proc = subprocess.Popen([sys.executable, str(RUNTIME / 'nebius-supervisor.py'), '--run-dir', str(root / 'receipt'), '--cwd', str(root), '--timeout', '5', '--grace', '.05', '--max-output-bytes', '100', '--', sys.executable, '-c', code], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 2
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(marker.exists())
            pid = int(marker.read_text())
            proc.terminate()
            output = proc.communicate(timeout=3)
            self.assertEqual(output, (b'', b''))
            receipt = json.loads((root / 'receipt' / 'receipt.json').read_bytes())
            self.assertEqual(receipt['receivedSignal'], 15)
            self.assertEqual(receipt['state'], 'terminated')
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    def test_supervisor_output_bound(self):
        p, r = self.supervisor("print('x'*200)", limit=100)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(r['state'], 'output_bound')
        self.assertFalse(r['outputComplete'])


if __name__ == '__main__':
    unittest.main()
