// Pure helpers shared by the Crisphive nodes. No n8n imports here, so the
// request shapes are unit-testable with node --test (test/lib.test.js).
import { createHmac, timingSafeEqual } from 'crypto';

export const DEFAULT_BASE_URL = 'https://api.crisphive.com';

export interface RequestSpec {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	path: string; // always starts with /v1/
	qs?: Record<string, string | number>;
	body?: Record<string, unknown>;
	headers?: Record<string, string>;
}

/** Idempotency key for a write inside one n8n execution + item. Stable across
 *  n8n's own retries of the same execution, so a retry replays the original
 *  booking instead of creating a second one. */
export function idempotencyKey(executionId: string, itemIndex: number, op: string): string {
	return `n8n-${executionId}-${itemIndex}-${op}`;
}

/** E.164 sanity check before calling the API — the API refuses anything else
 *  with PHONE_INVALID; failing early gives the workflow author a clear message. */
export function looksE164(phone: string): boolean {
	const digits = phone.replace(/[\s().-]/g, '');
	return /^\+[1-9]\d{6,14}$/.test(digits);
}

export function findCustomerByPhone(phone: string): RequestSpec {
	return { method: 'GET', path: '/v1/customers', qs: { phone, limit: 5 } };
}

export function getJobRequest(id: string): RequestSpec {
	return { method: 'GET', path: `/v1/job-requests/${encodeURIComponent(id)}` };
}

export function listJobTypes(): RequestSpec {
	return { method: 'GET', path: '/v1/job-types', qs: { status: 'active' } };
}

export interface CustomerInput {
	full_name: string;
	phone?: string;
	email?: string;
	sms_opt_in?: boolean;
}

export function createCustomer(c: CustomerInput, key: string): RequestSpec {
	return { method: 'POST', path: '/v1/customers', body: stripEmpty({ ...c }), headers: { 'Idempotency-Key': key } };
}

export interface BookAndConfirmInput {
	customer_id?: string;
	customer?: CustomerInput;
	address?: Record<string, unknown>;
	/** Optional: omitted, the business's default job type (and its duration) is used. */
	job_type_id?: string;
	scheduled_at: string;
	job_duration_minutes?: number;
	technician_id?: string;
	description?: string;
	priority?: string;
}

export function bookAndConfirm(input: BookAndConfirmInput, key: string): RequestSpec {
	return { method: 'POST', path: '/v1/job-requests/book-and-confirm', body: stripEmpty({ ...input }), headers: { 'Idempotency-Key': key } };
}

/** Idempotency key for ONE trigger activation. It MUST differ between
 *  activations: Crisphive replays a key's first 2xx response for 24h, so a
 *  static key made "deactivate, then reactivate within a day" return the id of
 *  the endpoint the deactivation had just DELETED — the trigger looked active
 *  and never received an event. A retry of the same activation reuses the
 *  activation id and stays safe. */
export function subscribeKey(scope: string, activationId: string): string {
	return `${scope}-${activationId}`;
}

/** Crisphive signing secrets expire (30 days by default); a subscription made
 *  by a trigger asks for the maximum so the trigger does not silently stop a
 *  month after activation. Past it Crisphive disables the endpoint and emails
 *  the business Owner; deactivating and reactivating the workflow re-subscribes. */
export const SUBSCRIPTION_SECRET_DAYS = 365;

export function subscribeWebhook(url: string, eventTypes: string[], key: string): RequestSpec {
	return {
		method: 'POST',
		path: '/v1/webhooks',
		body: { url, event_types: eventTypes, description: 'n8n trigger', expires_in_days: SUBSCRIPTION_SECRET_DAYS },
		headers: { 'Idempotency-Key': key },
	};
}

/** Accept a delivery only if `Crisphive-Signature` (`t=<unix>,v1=<hex>[,v1=<hex>]`)
 *  carries an HMAC-SHA256 of `<t>.<raw body>` under the endpoint's secret, and
 *  `t` is within `toleranceSec` of now (signatures are made at send time, so a
 *  retry is re-signed). Any matching v1 wins: during a secret rotation Crisphive
 *  signs with both secrets. */
export function verifySignature(rawBody: string | Buffer, header: string | undefined, secret: string, nowSec: number, toleranceSec = 300): boolean {
	if (!header || !secret) return false;
	let t = '';
	const sigs: string[] = [];
	for (const part of header.split(',')) {
		const i = part.indexOf('=');
		if (i < 0) continue;
		const k = part.slice(0, i).trim();
		const v = part.slice(i + 1).trim();
		if (k === 't') t = v;
		else if (k === 'v1') sigs.push(v);
	}
	const ts = Number(t);
	if (!t || !Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec || sigs.length === 0) return false;
	const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
	const want = createHmac('sha256', secret).update(`${t}.`).update(body).digest();
	return sigs.some((s) => {
		const got = Buffer.from(s, 'hex');
		return got.length === want.length && timingSafeEqual(got, want);
	});
}

/** The event catalogue (GET /v1/webhooks/event-types): a plain list of
 *  `resource.action` strings. Read live so a new Crisphive event appears in
 *  the trigger without a new release of this node. */
export function listWebhookEventTypes(): RequestSpec {
	return { method: 'GET', path: '/v1/webhooks/event-types' };
}

const RESOURCE_LABELS: Record<string, string> = { job_request: 'Job', customer: 'Customer', technician: 'Technician' };

/** `job_request.priority_changed` → `Job Priority Changed`. Unknown resources
 *  keep their own words, so an event added later still reads sensibly. */
export function eventLabel(type: string): string {
	const [resource, action = ''] = type.split('.');
	const words = (w: string) => w.split('_').filter(Boolean).map((x) => x[0].toUpperCase() + x.slice(1)).join(' ');
	return `${RESOURCE_LABELS[resource] ?? words(resource)} ${words(action)}`.trim();
}

/** Event list → n8n options, sorted by label (the n8n linter requires it). */
export function eventOptions(types: unknown): Array<{ name: string; value: string }> {
	const list = Array.isArray(types) ? types.filter((t): t is string => typeof t === 'string' && t !== 'ping') : [];
	return list.map((t) => ({ name: eventLabel(t), value: t })).sort((a, b) => a.name.localeCompare(b.name));
}

export function unsubscribeWebhook(id: string): RequestSpec {
	return { method: 'DELETE', path: `/v1/webhooks/${encodeURIComponent(id)}` };
}

/** A failed Crisphive call, carrying the stable error_code and its data. */
export class CrisphiveApiError extends Error {
	constructor(
		message: string,
		public readonly errorCode: string | number,
		public readonly data?: unknown,
	) {
		super(message);
		this.name = 'CrisphiveApiError';
	}
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
	return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Crisphive envelope → data, or throw with the stable error_code. */
export function unwrap(envelope: unknown): unknown {
	if (!isObject(envelope)) throw new Error('Crisphive: empty response');
	if (envelope.error_code === 0) return envelope.data;
	const code = (envelope.error_code as string | number | undefined) ?? 'UNKNOWN';
	// A permission refusal names the codes the credential lacks (e.g. customer
	// events without customers_view); put them in the message so the workflow
	// author can fix the role instead of guessing.
	const data = isObject(envelope.data) ? envelope.data : undefined;
	const need = data && Array.isArray(data.required_permissions) ? (data.required_permissions as unknown[]).map(String) : [];
	const hint = need.length ? ` (needs permission: ${need.join(', ')})` : '';
	throw new CrisphiveApiError(`Crisphive ${code}: ${String(envelope.message ?? '')}${hint}`.trim(), code, envelope.data);
}

/** True for the verification ping Crisphive sends WHILE the subscription is
 *  being created. It arrives before the create call has returned the secret,
 *  so it cannot be verified and must still be answered 2xx — otherwise the
 *  endpoint is born pending_verification and never receives an event. It is
 *  answered and never emitted, so a forged ping does nothing. */
export function isPing(body: unknown): boolean {
	return isObject(body) && body.type === 'ping';
}

export interface CrisphiveEvent {
	id: string;
	type: string;
	object: Json;
}

/** Webhook body → the event to emit, or null for the subscribe-time `ping`
 *  (and anything that is not a Crisphive event). */
export function eventFromWebhook(body: unknown): CrisphiveEvent | null {
	if (!isObject(body) || typeof body.type !== 'string') return null;
	if (body.type === 'ping') return null;
	const data = isObject(body.data) ? body.data : {};
	return { id: String(body.id ?? ''), type: body.type, object: isObject(data.object) ? data.object : {} };
}

function stripEmpty<T extends Record<string, unknown>>(o: T): T {
	for (const k of Object.keys(o)) {
		const v = o[k];
		if (v === undefined || v === '' || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)) delete o[k];
	}
	return o;
}
