"""Authored synthetic outputs/fake key and exchange only; no credentials/network."""
import copy
import importlib.util
import json
import pathlib
import subprocess
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('legacy_tests', HERE / 'runtime-worker-test.py')
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
w = legacy.w


class SpanWorkerTest(unittest.TestCase):
    fixture = legacy.WorkerTest.fixture

    def span_fixture(self):
        p, c, ledger, response = self.fixture()
        source = json.loads((p/'source.json').read_bytes())
        binding = w.digest(w.encoded(source['messages']))
        ix = w.span_index(source, 1, binding)
        ids = [ix['spans'][1]['id']]
        candidate = {'kind': 'source_span_draft_v1', 'sourceVersion': 1, 'sourceBinding': binding, 'fields': {k: ({'totalCents': 12000, 'currency': 'USD', 'spanIds': ids} if k == 'price' else {'text': 'Invented '+k, 'spanIds': ids}) for k in w.FIELDS}, 'exclusions': {'state': 'proposed', 'text': 'No invented resale', 'spanIds': ids}, 'questions': []}
        response['choices'][0]['message']['content'] = json.dumps(candidate)
        body = json.loads((p/'body.json').read_bytes())
        body['messages'][1]['content'] = json.dumps({'task': 'Authored test', 'messages': source['messages'], 'outputSchema': {}, 'spanIndex': ix}, ensure_ascii=False, separators=(',', ':'))
        self.rebind(p, c, body=body)
        return p, c, ledger, response, source, candidate

    def rebind(self, p, c, body=None, alter=None):
        manifest = json.loads((p/'manifest.json').read_bytes())
        admission = json.loads((p/'admission.json').read_bytes())
        permit = json.loads((c/'permit.json').read_bytes())
        if body is not None:
            (p/'body.json').write_bytes(w.encoded(body))
        admission['draftFormat'] = 'source_spans_v1'
        if alter:
            alter(admission)
        for n in manifest['files']:
            manifest['files'][n] = w.digest((p/n).read_bytes())
        mb = w.encoded(manifest)
        (p/'manifest.json').write_bytes(mb)
        admission['bodySHA256'] = w.digest(w.encoded(json.loads((p/'body.json').read_bytes())))
        admission['manifestSHA256'] = w.digest(mb)
        ab = w.encoded(admission)
        (p/'admission.json').write_bytes(ab)
        permit.update(packetSHA256=w.digest(mb), admissionSHA256=w.digest(ab), bodySHA256=admission['bodySHA256'])
        (c/'permit.json').write_bytes(w.encoded(permit))

    def test_valid_source_span_output_and_cost_settlement(self):
        p,c,l,r,_,expected = self.span_fixture()
        calls = []
        self.assertEqual(w.run(p,c,key_loader=lambda: calls.append('key') or 'AUTHORED_FAKE_KEY_ONLY', fetch=lambda *_: (calls.append('post') or 200,r)),0)
        self.assertEqual(calls,['key','post'])
        self.assertEqual(json.loads((c/'candidate.json').read_bytes()),expected)
        self.assertEqual(json.loads((l/'budget.json').read_bytes())['spentNanoUSD'],135000)
        self.assertEqual(w.run(p,c,key_loader=lambda: self.fail('replayed key')),1)

    def test_hallucinated_stale_duplicate_and_wrong_shape_are_settled_rejections(self):
        changes = [lambda x:x['fields']['terms'].update(spanIds=['invented']),lambda x:x.update(sourceVersion=2),lambda x:x.update(sourceBinding='a'*64),lambda x:x['fields']['usage']['spanIds'].append(x['fields']['usage']['spanIds'][0]),lambda x:x['exclusions'].update(state='none_found'),lambda x:x['fields']['terms'].update(refs=[]),lambda x:x.update(sourceVersion=True)]
        for edit in changes:
            with self.subTest(edit=edit):
                p,c,l,r,_,x=self.span_fixture()
                edit(x)
                r['choices'][0]['message']['content']=json.dumps(x)
                self.assertEqual(w.run(p,c,key_loader=lambda:'AUTHORED_FAKE_KEY_ONLY',fetch=lambda *_:(200,r)),1)
                exit=json.loads((c/'worker-exit.json').read_bytes())
                self.assertEqual(exit['stage'],'protocol_validation')
                self.assertTrue(exit['usageSettled'])
                self.assertFalse((c/'candidate.json').exists())
                self.assertEqual(json.loads((l/'budget.json').read_bytes())['spentNanoUSD'],135000)

    def test_wrong_index_format_or_source_fails_before_budget_or_key(self):
        for kind in ['index','messages','format','keys']:
            p,c,l,r,_,_=self.span_fixture()
            body=json.loads((p/'body.json').read_bytes())
            user=json.loads(body['messages'][1]['content'])
            if kind=='index':user['spanIndex']['spans'][0]['quote']='Invented different text'
            if kind=='messages':user['messages'][0]['text']='Invented different source'
            if kind=='keys':user['extra']=True
            body['messages'][1]['content']=json.dumps(user)
            self.rebind(p,c,body=body,alter=(lambda a:a.update(draftFormat='invented')) if kind=='format' else None)
            self.assertEqual(w.run(p,c,key_loader=lambda:self.fail('key'),fetch=lambda *_:self.fail('post')),1)
            self.assertFalse((l/'budget.json').exists())

    def test_unknown_exchange_preserves_full_reservation_and_no_candidate(self):
        p,c,l,_,_,_=self.span_fixture()
        def failed(*_):raise RuntimeError('AUTHORED_SECRET_NOT_PUBLIC')
        self.assertEqual(w.run(p,c,key_loader=lambda:'AUTHORED_FAKE_KEY_ONLY',fetch=failed),1)
        b=json.loads((l/'budget.json').read_bytes())
        self.assertEqual(b['spentNanoUSD'],w.RESERVE)
        self.assertEqual(b['records'][0]['state'],'possible')
        self.assertEqual(json.loads((c/'worker-exit.json').read_bytes())['unknownReservationNanoUSD'],w.RESERVE)
        self.assertFalse((c/'candidate.json').exists())

    def test_unicode_boundary_and_all_span_bytes_match_real_node_protocol(self):
        messages=[{'id':'M1','role':'merchant','text':'a'*199+'🪁'+'é'*250}]
        source={'messages':messages}
        binding=w.digest(w.encoded(messages))
        ix=w.span_index(source,1,binding)
        script="const S=require('./span-draft-protocol');const s=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(S.index(s)))"
        full={**source,'version':1,'binding':binding}
        actual=subprocess.run(['node','-e',script,json.dumps(full,ensure_ascii=False)],cwd=HERE.parent,capture_output=True,check=True,timeout=5)
        self.assertEqual(json.loads(actual.stdout),ix)
        self.assertEqual(''.join(s['quote'] for s in ix['spans']),messages[0]['text'])

    def test_late_response_remains_unknown_and_cannot_settle_or_publish(self):
        p,c,l,r,_,_=self.span_fixture()
        now=[0]
        def late(*_):
            now[0]=91
            return 200,r
        self.assertEqual(w.run(p,c,key_loader=lambda:'AUTHORED_FAKE_KEY_ONLY',fetch=late,clock=lambda:now[0]),1)
        b=json.loads((l/'budget.json').read_bytes())
        self.assertEqual(b['spentNanoUSD'],w.RESERVE)
        self.assertEqual(b['records'][0]['state'],'possible')
        self.assertFalse((c/'candidate.json').exists())
        self.assertFalse((c/'usage.json').exists())

    def test_literal_ids_do_not_prove_semantic_truth_or_exclusion_completeness(self):
        _,_,_,_,source,x=self.span_fixture()
        x['fields']['usage']['text']='Invented unsupported unlimited rights.'
        x['exclusions']={'state':'none_found','text':'','spanIds':[]}
        self.assertEqual(w.span_candidate(x,source,1,x['sourceBinding']),x)


if __name__=='__main__':
    unittest.main()
