'use strict';

// Pure, volatile, human-authored enquiry/quote model. No transport, authentication,
// image recognition, inventory, reservation, payment or clock. Caller owns access.
const { createHash } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, names) => object(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const serialized = v => JSON.stringify(canonical(v));
const hash = v => createHash('sha256').update(serialized(v)).digest('hex');
const same = (a, b) => serialized(a) === serialized(b);
const dense = a => Array.isArray(a) && Object.keys(a).length === a.length && Object.keys(a).every((k, i) => k === String(i));
function requireThat(ok, code) { if (!ok) throw Object.assign(new Error(code), { code, status: 409 }); }
function freeze(v) { if (object(v) || Array.isArray(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function text(v, maximum, optional = false) {
  return typeof v === 'string' && v.trim() === v && (optional || v.length > 0) && v.length <= maximum &&
    v.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v);
}
function anchor(v) {
  requireThat(exact(v, ['x', 'y']) && ['x', 'y'].every(k => Number.isSafeInteger(v[k]) && v[k] >= 0 && v[k] <= 1000), 'invalid_point');
  return { x: v.x, y: v.y };
}
function sceneFacts(s) {
  requireThat(exact(s, ['lifetimeId', 'photoId', 'photoSha256', 'width', 'height']) && typeof s.lifetimeId === 'string' && UUID.test(s.lifetimeId) &&
    typeof s.photoId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s.photoId) && typeof s.photoSha256 === 'string' && /^[a-f0-9]{64}$/.test(s.photoSha256) &&
    Number.isSafeInteger(s.width) && Number.isSafeInteger(s.height) && s.width >= 320 && s.width <= 8000 && s.height >= 240 && s.height <= 8000 && s.width * s.height <= 16000000, 'invalid_scene');
  return { lifetimeId: s.lifetimeId, photoId: s.photoId, photoSha256: s.photoSha256, width: s.width, height: s.height };
}
function pointsFacts(points) {
  requireThat(dense(points) && points.length >= 1 && points.length <= 12, 'invalid_enquiry_points');
  const locations = new Set();
  return points.map((p, index) => {
    requireThat(exact(p, ['hint', 'anchor']) && text(p.hint, 72, true), 'invalid_enquiry_point');
    const a = anchor(p.anchor), key = `${a.x}:${a.y}`;
    requireThat(!locations.has(key), 'duplicate_point'); locations.add(key);
    // Point numbers refer to buyer-authored marks, never generated object identity.
    return { point: index + 1, hint: p.hint, anchor: a };
  });
}
function quoteLines(record, lines) {
  requireThat(dense(lines) && lines.length === record.points.length, 'quote_point_count');
  const seen = new Set(), locations = new Set();
  return lines.map(l => {
    requireThat(exact(l, ['point', 'title', 'note', 'anchor', 'priceCents']) && Number.isInteger(l.point) && l.point >= 1 && l.point <= record.points.length &&
      !seen.has(l.point) && text(l.title, 72) && Buffer.byteLength(l.title, 'utf8') <= 127 && text(l.note, 180, true) &&
      Number.isSafeInteger(l.priceCents) && l.priceCents >= 1 && l.priceCents <= 100000, 'invalid_quote_line');
    const a = anchor(l.anchor), location = `${a.x}:${a.y}`;
    requireThat(!locations.has(location), 'duplicate_quote_location'); seen.add(l.point); locations.add(location);
    return { point: l.point, title: l.title, note: l.note, anchor: a, priceCents: l.priceCents };
  }).sort((a, b) => a.point - b.point);
}
function quoteFacts(record, revision, lines) {
  return { enquiryId: record.id, revision, scene: sceneFacts(record.scene), requestedPoints: record.points,
    currency: 'USD', lines, totalCents: lines.reduce((n, l) => n + l.priceCents, 0) };
}
function revision(record) { return record.quotes.length; }
function currentQuote(record) { return record.quotes.at(-1) || null; }
function pendingClarification(record) { return record.clarifications.find(c => c.withdrawal === null && c.answer === null) || null; }
function requireScene(record, scene) { requireThat(same(sceneFacts(scene), record.scene), 'enquiry_scene_expired'); }
function usedKeys(record) { return [record.id, ...record.quotes.map(q => q.requestKey), ...record.acceptances.map(a => a.requestKey),
  ...record.clarifications.flatMap(c => [c.requestKey, ...(c.withdrawal ? [c.withdrawal.requestKey] : [])]), ...(record.closure ? [record.closure.requestKey] : [])]; }
const ASK = 'request-object-clarification-not-accept-quote';
const WITHDRAW = 'withdraw-this-clarification-not-accept-quote';
function clarificationFingerprint(input) { return hash({ expectedRevision: input.expectedRevision, quoteBinding: input.quoteBinding,
  point: input.point, question: input.question, confirmation: ASK }); }
function withdrawalFingerprint(input) { return hash({ expectedRevision: input.expectedRevision, quoteBinding: input.quoteBinding,
  clarificationKey: input.clarificationKey, confirmation: WITHDRAW }); }
function validateRecord(r) {
  requireThat(exact(r, ['schema', 'id', 'scene', 'points', 'enquiryFingerprint', 'quotes', 'acceptances', 'clarifications', 'closure']) && r.schema === 1 &&
    typeof r.id === 'string' && UUID.test(r.id), 'invalid_record');
  const scene = sceneFacts(r.scene);
  requireThat(Array.isArray(r.points), 'invalid_record');
  const points = pointsFacts(r.points.map(p => ({ hint: p.hint, anchor: p.anchor })));
  requireThat(same(points, r.points) && r.enquiryFingerprint === hash({ scene, points }) &&
    dense(r.quotes) && r.quotes.length <= 6 && dense(r.acceptances) && r.acceptances.length <= 6 && dense(r.clarifications) && r.clarifications.length <= 6, 'invalid_record');
  for (const [i, q] of r.quotes.entries()) {
    requireThat(exact(q, ['requestKey', 'inputFingerprint', 'revision', 'scene', 'enquiryId', 'requestedPoints', 'currency', 'lines', 'totalCents', 'binding']) &&
      typeof q.requestKey === 'string' && UUID.test(q.requestKey) && typeof q.inputFingerprint === 'string' && /^[a-f0-9]{64}$/.test(q.inputFingerprint), 'invalid_record_quote');
    const facts = quoteFacts(r, i + 1, quoteLines(r, q.lines));
    const { requestKey, inputFingerprint, binding, ...stored } = q;
    requireThat(same(stored, facts) && binding === hash(facts) && inputFingerprint === hash({ expectedRevision: i, lines: facts.lines,
      visualConfirmation: 'seller-inspected-requested-objects-and-confirmed-these-points' }), 'invalid_record_quote');
  }
  const acceptedRevisions = new Set();
  for (const a of r.acceptances) {
    requireThat(exact(a, ['requestKey', 'revision', 'quoteBinding']) && typeof a.requestKey === 'string' && UUID.test(a.requestKey) &&
      Number.isInteger(a.revision) && r.quotes[a.revision - 1]?.binding === a.quoteBinding && !acceptedRevisions.has(a.revision), 'invalid_record_acceptance');
    acceptedRevisions.add(a.revision);
  }
  requireThat(r.closure === null || exact(r.closure, ['requestKey', 'revision']) && typeof r.closure.requestKey === 'string' && UUID.test(r.closure.requestKey) && r.closure.revision === revision(r), 'invalid_record_closure');
  const answeredQuotes = new Set(); let pending = null;
  for (const c of r.clarifications) {
    requireThat(exact(c, ['requestKey', 'inputFingerprint', 'revision', 'quoteBinding', 'point', 'question', 'withdrawal', 'answer']) &&
      typeof c.requestKey === 'string' && UUID.test(c.requestKey) && Number.isInteger(c.revision) && c.revision >= 1 && c.revision < 6 &&
      r.quotes[c.revision - 1]?.binding === c.quoteBinding && Number.isInteger(c.point) && c.point >= 1 && c.point <= r.points.length &&
      text(c.question, 180) && c.inputFingerprint === clarificationFingerprint({ expectedRevision: c.revision, quoteBinding: c.quoteBinding, point: c.point, question: c.question }) &&
      (c.withdrawal === null || object(c.withdrawal)) && (c.answer === null || object(c.answer)) &&
      (c.withdrawal === null || c.answer === null) && (c.withdrawal !== null || !r.acceptances.some(a => a.quoteBinding === c.quoteBinding)), 'invalid_record_clarification');
    if (c.withdrawal !== null) requireThat(exact(c.withdrawal, ['requestKey', 'inputFingerprint']) && typeof c.withdrawal.requestKey === 'string' && UUID.test(c.withdrawal.requestKey) &&
      c.withdrawal.inputFingerprint === withdrawalFingerprint({ expectedRevision: c.revision, quoteBinding: c.quoteBinding, clarificationKey: c.requestKey }), 'invalid_record_withdrawal');
    if (c.answer !== null) {
      const q = r.quotes[c.answer.revision - 1], previous = r.quotes[c.revision - 1];
      requireThat(exact(c.answer, ['quoteRequestKey', 'revision', 'quoteBinding']) && typeof c.answer.quoteRequestKey === 'string' && UUID.test(c.answer.quoteRequestKey) &&
        Number.isInteger(c.answer.revision) && c.answer.revision === c.revision + 1 && q?.requestKey === c.answer.quoteRequestKey &&
        q.binding === c.answer.quoteBinding && !answeredQuotes.has(q.requestKey) && q.lines[c.point - 1].note.length > 0 && q.lines[c.point - 1].note !== previous.lines[c.point - 1].note,
      'invalid_record_clarification_answer');
      answeredQuotes.add(q.requestKey);
    }
    if (c.withdrawal === null && c.answer === null) {
      requireThat(pending === null && c.revision === revision(r) && c.quoteBinding === currentQuote(r)?.binding &&
        !r.acceptances.some(a => a.quoteBinding === c.quoteBinding), 'invalid_record_pending_clarification'); pending = c;
    }
  }
  const keys = usedKeys(r); requireThat(new Set(keys).size === keys.length, 'operation_key_reused');
  return r;
}

function createEnquiry(currentScene, input, existing = null) {
  requireThat(exact(input, ['requestKey', 'expectedScene', 'points']) && typeof input.requestKey === 'string' && UUID.test(input.requestKey), 'invalid_enquiry');
  const scene = sceneFacts(currentScene), expected = sceneFacts(input.expectedScene), points = pointsFacts(input.points);
  const fingerprint = hash({ scene: expected, points });
  if (existing) {
    validateRecord(existing);
    requireThat(existing.id === input.requestKey && existing.enquiryFingerprint === fingerprint, 'enquiry_key_mismatch');
    // Historical replay is readback only. It never rebinds to the current scene.
    return { record: existing, replayed: true };
  }
  requireThat(same(scene, expected), 'enquiry_scene_expired');
  return { record: freeze({ schema: 1, id: input.requestKey, scene, points, enquiryFingerprint: fingerprint, quotes: [], acceptances: [], clarifications: [], closure: null }), replayed: false };
}

function proposeQuote(record, currentScene, input, answeringClarificationKey = null) {
  validateRecord(record);
  requireThat(exact(input, ['requestKey', 'expectedRevision', 'lines', 'visualConfirmation']) && typeof input.requestKey === 'string' && UUID.test(input.requestKey) &&
    Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0 && input.expectedRevision <= 6 && input.visualConfirmation === 'seller-inspected-requested-objects-and-confirmed-these-points', 'invalid_quote');
  const lines = quoteLines(record, input.lines);
  const fingerprint = hash({ expectedRevision: input.expectedRevision, lines, visualConfirmation: input.visualConfirmation });
  const replay = record.quotes.find(q => q.requestKey === input.requestKey);
  if (replay) {
    requireThat(replay.inputFingerprint === fingerprint, 'quote_key_mismatch');
    // Answer identity is workflow metadata, NOT a new quote/hash/payment field.
    // Historical replay cannot attach an old quote to a new clarification.
    const originalAnswer = record.clarifications.find(c => c.answer?.quoteRequestKey === replay.requestKey)?.requestKey || null;
    requireThat(originalAnswer === answeringClarificationKey, 'quote_clarification_key_mismatch');
    return { record, operationQuote: replay, replayed: true };
  }
  requireThat(!usedKeys(record).includes(input.requestKey), 'operation_key_reused');
  requireScene(record, currentScene); requireThat(!record.closure, 'enquiry_closed');
  requireThat(input.expectedRevision === revision(record), 'stale_quote_revision');
  requireThat(record.quotes.length < 6, 'quote_revision_limit');
  requireThat(!currentQuote(record) || !same(lines, currentQuote(record).lines), 'quote_terms_unchanged');
  const clarification = pendingClarification(record);
  if (clarification) {
    requireThat(answeringClarificationKey === clarification.requestKey, 'clarification_answer_required');
    requireThat(lines[clarification.point - 1].note.length > 0 && lines[clarification.point - 1].note !== currentQuote(record).lines[clarification.point - 1].note, 'clarification_new_note_required');
  } else requireThat(answeringClarificationKey === null, 'clarification_not_active');
  const facts = quoteFacts(record, revision(record) + 1, lines);
  const quote = freeze({ requestKey: input.requestKey, inputFingerprint: fingerprint, ...facts, binding: hash(facts) });
  // Old acceptance remains historical; only acceptance of the newest hash counts.
  const clarifications = clarification ? record.clarifications.map(c => c.requestKey === clarification.requestKey ? { ...c,
    answer: { quoteRequestKey: quote.requestKey, revision: quote.revision, quoteBinding: quote.binding } } : c) : record.clarifications;
  // The new note is a response artifact, never proof it semantically answers.
  const next = freeze({ ...record, quotes: [...record.quotes, quote], clarifications });
  return { record: next, operationQuote: quote, replayed: false };
}

function requestClarification(record, currentScene, input) {
  validateRecord(record);
  requireThat(exact(input, ['requestKey', 'expectedRevision', 'quoteBinding', 'point', 'question', 'confirmation']) && typeof input.requestKey === 'string' && UUID.test(input.requestKey) &&
    Number.isInteger(input.expectedRevision) && input.expectedRevision >= 1 && input.expectedRevision <= 6 && typeof input.quoteBinding === 'string' && /^[a-f0-9]{64}$/.test(input.quoteBinding) &&
    Number.isInteger(input.point) && input.point >= 1 && input.point <= record.points.length && text(input.question, 180) && input.confirmation === ASK, 'invalid_clarification');
  const fingerprint = clarificationFingerprint(input), replay = record.clarifications.find(c => c.requestKey === input.requestKey);
  if (replay) {
    requireThat(replay.inputFingerprint === fingerprint, 'clarification_key_mismatch');
    return { record, operationClarification: replay, replayed: true };
  }
  requireThat(!usedKeys(record).includes(input.requestKey), 'operation_key_reused');
  requireScene(record, currentScene); requireThat(!record.closure, 'enquiry_closed');
  const quote = currentQuote(record);
  requireThat(quote && quote.revision === input.expectedRevision && quote.binding === input.quoteBinding, 'stale_clarification_quote');
  requireThat(!record.acceptances.some(a => a.quoteBinding === quote.binding), 'clarification_after_acceptance');
  requireThat(quote.revision < 6, 'clarification_quote_revision_limit');
  requireThat(!pendingClarification(record), 'clarification_pending'); requireThat(record.clarifications.length < 6, 'clarification_limit');
  const clarification = freeze({ requestKey: input.requestKey, inputFingerprint: fingerprint, revision: quote.revision, quoteBinding: quote.binding,
    point: input.point, question: input.question, withdrawal: null, answer: null });
  return { record: freeze({ ...record, clarifications: [...record.clarifications, clarification] }), operationClarification: clarification, replayed: false };
}

function withdrawClarification(record, currentScene, input) {
  validateRecord(record);
  requireThat(exact(input, ['requestKey', 'expectedRevision', 'quoteBinding', 'clarificationKey', 'confirmation']) && typeof input.requestKey === 'string' && UUID.test(input.requestKey) &&
    Number.isInteger(input.expectedRevision) && input.expectedRevision >= 1 && input.expectedRevision < 6 && typeof input.quoteBinding === 'string' && /^[a-f0-9]{64}$/.test(input.quoteBinding) &&
    typeof input.clarificationKey === 'string' && UUID.test(input.clarificationKey) && input.confirmation === WITHDRAW, 'invalid_clarification_withdrawal');
  const fingerprint = withdrawalFingerprint(input), replay = record.clarifications.find(c => c.withdrawal?.requestKey === input.requestKey);
  if (replay) {
    requireThat(replay.withdrawal.inputFingerprint === fingerprint, 'clarification_withdrawal_key_mismatch');
    return { record, operationWithdrawal: replay.withdrawal, replayed: true };
  }
  requireThat(!usedKeys(record).includes(input.requestKey), 'operation_key_reused');
  requireScene(record, currentScene); requireThat(!record.closure, 'enquiry_closed');
  const quote = currentQuote(record), pending = pendingClarification(record);
  requireThat(quote && quote.revision === input.expectedRevision && quote.binding === input.quoteBinding, 'stale_clarification_quote');
  requireThat(pending && pending.requestKey === input.clarificationKey, 'clarification_not_active');
  const withdrawal = freeze({ requestKey: input.requestKey, inputFingerprint: fingerprint });
  return { record: freeze({ ...record, clarifications: record.clarifications.map(c => c.requestKey === pending.requestKey ? { ...c, withdrawal } : c) }), operationWithdrawal: withdrawal, replayed: false };
}

function acceptQuote(record, currentScene, input) {
  validateRecord(record);
  requireThat(exact(input, ['requestKey', 'expectedRevision', 'quoteBinding']) && typeof input.requestKey === 'string' && UUID.test(input.requestKey) &&
    Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 1 && input.expectedRevision <= 6 && typeof input.quoteBinding === 'string' && /^[a-f0-9]{64}$/.test(input.quoteBinding), 'invalid_acceptance');
  const replay = record.acceptances.find(a => a.requestKey === input.requestKey);
  if (replay) {
    requireThat(replay.revision === input.expectedRevision && replay.quoteBinding === input.quoteBinding, 'acceptance_key_mismatch');
    return { record, operationAcceptance: replay, replayed: true };
  }
  requireThat(!usedKeys(record).includes(input.requestKey), 'operation_key_reused');
  requireScene(record, currentScene); requireThat(!record.closure, 'enquiry_closed');
  const quote = currentQuote(record);
  requireThat(quote && quote.revision === input.expectedRevision && quote.binding === input.quoteBinding, 'stale_quote_acceptance');
  requireThat(!pendingClarification(record), 'clarification_pending');
  const known = record.acceptances.find(a => a.revision === quote.revision);
  requireThat(!known, 'quote_already_accepted_read_receipt'); // New key/object is not another consent operation.
  const accepted = freeze({ requestKey: input.requestKey, revision: quote.revision, quoteBinding: quote.binding });
  return { record: freeze({ ...record, acceptances: [...record.acceptances, accepted] }), operationAcceptance: accepted, replayed: false };
}

function closeEnquiry(record, currentScene, input) {
  validateRecord(record);
  requireThat(exact(input, ['requestKey', 'expectedRevision']) && typeof input.requestKey === 'string' && UUID.test(input.requestKey) &&
    Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0 && input.expectedRevision <= 6, 'invalid_closure');
  if (record.closure?.requestKey === input.requestKey) {
    requireThat(record.closure.revision === input.expectedRevision, 'closure_key_mismatch'); return { record, replayed: true };
  }
  requireThat(!usedKeys(record).includes(input.requestKey), 'operation_key_reused');
  requireScene(record, currentScene); requireThat(!record.closure && input.expectedRevision === revision(record), 'stale_enquiry_closure');
  return { record: freeze({ ...record, closure: { requestKey: input.requestKey, revision: revision(record) } }), replayed: false };
}

function projectEnquiry(record, currentScene) {
  validateRecord(record);
  const expired = !same(sceneFacts(currentScene), record.scene), quote = currentQuote(record);
  const acceptance = quote ? record.acceptances.find(a => a.quoteBinding === quote.binding) || null : null;
  const clarificationHistory = record.clarifications.map(c => ({ id: c.requestKey, revision: c.revision, quoteBinding: c.quoteBinding, point: c.point, question: c.question,
    status: c.answer ? 'response_in_quote' : c.withdrawal ? 'withdrawn' : expired ? 'expired' : record.closure ? 'closed' : 'pending', answer: c.answer }));
  return freeze({ id: record.id, scene: record.scene, points: record.points, revision: revision(record), quote,
    quoteHistory: record.quotes, acceptanceHistory: record.acceptances, clarificationHistory, pendingClarification: clarificationHistory.find(c => c.status === 'pending') || null,
    phase: expired ? 'expired' : record.closure ? 'cannot_quote' : acceptance ? 'accepted_quote' : quote ? 'quoted' : 'unpriced_enquiry',
    acceptanceCurrent: !expired && !record.closure && !!acceptance,
    quoteAcceptanceCreatesPayment: false, quoteAcceptanceCreatesReservation: false });
}

function currentAcceptedQuote(record, currentScene, input) {
  const view = projectEnquiry(record, currentScene);
  requireThat(exact(input, ['expectedRevision', 'quoteBinding']) && view.acceptanceCurrent && view.quote.revision === input.expectedRevision &&
    view.quote.binding === input.quoteBinding, 'current_quote_not_accepted');
  return view.quote; // Still not permission/payment/reservation or provider evidence.
}

module.exports = { createEnquiry, proposeQuote, acceptQuote, closeEnquiry, projectEnquiry, currentAcceptedQuote, requestClarification, withdrawClarification };
