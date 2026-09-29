const test = require('node:test');
const assert = require('node:assert');
const api = require('../dist/lib/crisphive.js');

test('book-and-confirm carries an idempotency key and drops empty fields', () => {
	const s = api.bookAndConfirm({ customer_id: 'c1', job_type_id: 'jt', scheduled_at: '2026-10-06T10:00:00', description: '' }, api.idempotencyKey('exec9', 2, 'book-and-confirm'));
	assert.equal(s.method, 'POST');
	assert.equal(s.path, '/v1/job-requests/book-and-confirm');
	assert.equal(s.headers['Idempotency-Key'], 'n8n-exec9-2-book-and-confirm');
	assert.deepEqual(Object.keys(s.body).sort(), ['customer_id', 'job_type_id', 'scheduled_at']);
});

test('book-and-confirm without a job type sends none (the business default is used)', () => {
	const s = api.bookAndConfirm({ customer_id: 'c1', job_type_id: undefined, scheduled_at: '2026-10-06T10:00:00' }, 'k');
	assert.ok(!('job_type_id' in s.body));
});

test('the same execution + item always yields the same key (n8n retry safety)', () => {
	assert.equal(api.idempotencyKey('e', 0, 'x'), api.idempotencyKey('e', 0, 'x'));
	assert.notEqual(api.idempotencyKey('e', 0, 'x'), api.idempotencyKey('e', 1, 'x'));
});

test('phone lookup is the exact ?phone= filter, never q', () => {
	const s = api.findCustomerByPhone('+16135550142');
	assert.deepEqual(s.qs, { phone: '+16135550142', limit: 5 });
});

test('E.164 check accepts separators and refuses a bare national number', () => {
	assert.ok(api.looksE164('+1 (613) 555-0142'));
	assert.ok(!api.looksE164('6135550142'));
});

test('unwrap returns data on success and throws the stable code on failure', () => {
	assert.deepEqual(api.unwrap({ error_code: 0, data: { a: 1 } }), { a: 1 });
	assert.throws(() => api.unwrap({ error_code: 'PHONE_INVALID', message: 'bad' }), (e) => e.errorCode === 'PHONE_INVALID');
});

test('webhook: the subscribe-time ping is dropped, events pass through', () => {
	assert.equal(api.eventFromWebhook({ type: 'ping', id: 'evt_1' }), null);
	assert.equal(api.eventFromWebhook({ nope: true }), null);
	const e = api.eventFromWebhook({ id: 'evt_2', type: 'job_request.completed', data: { object: { id: 'j1' } } });
	assert.deepEqual(e, { id: 'evt_2', type: 'job_request.completed', object: { id: 'j1' } });
});

test('each trigger activation gets its own subscribe key (no replay of a deleted endpoint)', () => {
	assert.notEqual(api.subscribeKey('n8n-sub-wf-node', '1'), api.subscribeKey('n8n-sub-wf-node', '2'));
});

test('subscribe and unsubscribe hit the /v1 webhook triple', () => {
	const s = api.subscribeWebhook('https://n8n.example/webhook/abc', ['job_request.completed'], 'k');
	assert.equal(s.path, '/v1/webhooks');
	assert.deepEqual(s.body.event_types, ['job_request.completed']);
	assert.equal(s.body.expires_in_days, 365, 'a trigger must not die with the 30-day default secret');
	assert.equal(api.unsubscribeWebhook('w1').path, '/v1/webhooks/w1');
});

// Vector produced by crisphive-api's own webhook.Sign / webhook.SignMulti
// (internal/webhook/signing.go), so this proves byte-level compatibility.
const VEC_BODY = '{"id":"evt_3f9a","type":"job_request.completed","created_at":"2026-09-28T15:00:00Z","data":{"object":{"id":"b6c2e0d4-1f7a-4c8e-9a3b-5d2e7f1a0c9b","short_code":"REQ-7K2M","status":"completed","note":"café <ok> & ü"}}}';
const VEC_T = 1790000000;
const VEC_ONE = 't=1790000000,v1=b4f024839c15368befe3563aa3ae080698b643b01450c7a5f9ac08bb00588ec5';
const VEC_ROTATING = 't=1790000000,v1=d2e397fd7834e97582e045fcfafd82be6a53d19c01a7857279a5241e1f84f505,v1=b4f024839c15368befe3563aa3ae080698b643b01450c7a5f9ac08bb00588ec5';

test('signature: a Crisphive-signed delivery verifies (string and Buffer body)', () => {
	assert.ok(api.verifySignature(VEC_BODY, VEC_ONE, 'whsec_test_secret_A', VEC_T));
	assert.ok(api.verifySignature(Buffer.from(VEC_BODY, 'utf8'), VEC_ONE, 'whsec_test_secret_A', VEC_T + 60));
});

test('signature: during a rotation either secret verifies', () => {
	assert.ok(api.verifySignature(VEC_BODY, VEC_ROTATING, 'whsec_test_secret_A', VEC_T));
	assert.ok(api.verifySignature(VEC_BODY, VEC_ROTATING, 'whsec_test_secret_B', VEC_T));
});

test('signature: wrong secret, tampered body, stale timestamp and garbage are refused', () => {
	assert.ok(!api.verifySignature(VEC_BODY, VEC_ONE, 'whsec_other', VEC_T));
	assert.ok(!api.verifySignature(VEC_BODY.replace('completed', 'archived'), VEC_ONE, 'whsec_test_secret_A', VEC_T));
	assert.ok(!api.verifySignature(VEC_BODY, VEC_ONE, 'whsec_test_secret_A', VEC_T + 301));
	assert.ok(!api.verifySignature(VEC_BODY, undefined, 'whsec_test_secret_A', VEC_T));
	assert.ok(!api.verifySignature(VEC_BODY, 'v1=abc', 'whsec_test_secret_A', VEC_T));
	assert.ok(!api.verifySignature(VEC_BODY, VEC_ONE, '', VEC_T));
});

test('the subscribe-time ping is recognised so it can be answered without a secret', () => {
	assert.ok(api.isPing({ type: 'ping' }));
	assert.ok(!api.isPing({ type: 'job_request.completed' }));
	assert.ok(!api.isPing(null));
});

test('event labels read naturally, including events added later', () => {
	assert.equal(api.eventLabel('job_request.completed'), 'Job Completed');
	assert.equal(api.eventLabel('job_request.priority_changed'), 'Job Priority Changed');
	assert.equal(api.eventLabel('technician.deleted'), 'Technician Deleted');
	assert.equal(api.eventLabel('invoice.paid'), 'Invoice Paid');
});

test('event options come from the live catalogue, sorted, without ping', () => {
	const o = api.eventOptions(['job_request.created', 'customer.created', 'ping', 7]);
	assert.deepEqual(o, [{ name: 'Customer Created', value: 'customer.created' }, { name: 'Job Created', value: 'job_request.created' }]);
	assert.deepEqual(api.eventOptions(null), []);
	assert.equal(api.listWebhookEventTypes().path, '/v1/webhooks/event-types');
});
