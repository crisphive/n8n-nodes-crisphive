import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import * as api from '../../lib/crisphive';

async function call(ctx: IExecuteFunctions, spec: api.RequestSpec): Promise<unknown> {
	const creds = await ctx.getCredentials('crisphiveApi');
	const opts: IHttpRequestOptions = {
		method: spec.method,
		baseURL: (creds.baseUrl as string) || api.DEFAULT_BASE_URL,
		url: spec.path,
		qs: spec.qs as IDataObject,
		body: spec.body as IDataObject,
		headers: spec.headers,
		json: true,
		// Crisphive answers errors as an envelope with a stable error_code; read
		// it instead of letting n8n turn every 4xx into an opaque "Bad request".
		ignoreHttpStatusErrors: true,
	};
	const res = await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'crisphiveApi', opts);
	return api.unwrap(res);
}

const bookOnly = { show: { operation: ['bookAndConfirm'] } };

export class Crisphive implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Crisphive',
		name: 'crisphive',
		icon: { light: 'file:crisphive.svg', dark: 'file:crisphive.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Find callers, book and confirm field jobs in one call, read bookings.',
		defaults: { name: 'Crisphive' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'crisphiveApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'bookAndConfirm',
				options: [
					{ name: 'Book and Confirm Job', value: 'bookAndConfirm', description: 'Book, schedule and confirm a job at a chosen time in one call', action: 'Book and confirm a job' },
					{ name: 'Create Customer', value: 'createCustomer', action: 'Create a customer' },
					{ name: 'Find Customer by Phone', value: 'findCustomer', description: 'Exact E.164 match', action: 'Find a customer by phone' },
					{ name: 'Get Job', value: 'getJob', action: 'Get a job' },
					{ name: 'List Job Types', value: 'listJobTypes', action: 'List job types' },
				],
			},
			{ displayName: 'Customer ID', name: 'customerId', type: 'string', default: '', displayOptions: bookOnly, description: 'An existing customer. Leave empty to match-or-create from the fields below.' },
			{ displayName: 'Full Name', name: 'fullName', type: 'string', default: '', displayOptions: { show: { operation: ['bookAndConfirm', 'createCustomer'] } } },
			{ displayName: 'Phone (E.164)', name: 'phone', type: 'string', default: '', placeholder: '+16135550142', displayOptions: { show: { operation: ['bookAndConfirm', 'createCustomer', 'findCustomer'] } } },
			{ displayName: 'Email', name: 'email', type: 'string', default: '', placeholder: 'name@email.com', displayOptions: { show: { operation: ['bookAndConfirm', 'createCustomer'] } } },
			{ displayName: 'SMS Consent', name: 'smsOptIn', type: 'boolean', default: false, displayOptions: { show: { operation: ['bookAndConfirm', 'createCustomer'] } }, description: 'Whether the customer explicitly agreed to text messages. Leave off otherwise.' },
			{ displayName: 'Address Line', name: 'addressLine', type: 'string', default: '', displayOptions: bookOnly, description: 'Required when booking a new customer' },
			{ displayName: 'City', name: 'city', type: 'string', default: '', displayOptions: bookOnly },
			{ displayName: 'State / Province', name: 'state', type: 'string', default: '', placeholder: 'ON', displayOptions: bookOnly },
			{ displayName: 'Postal Code', name: 'postalCode', type: 'string', default: '', displayOptions: bookOnly },
			{ displayName: 'Country', name: 'country', type: 'string', default: '', placeholder: 'CA', displayOptions: bookOnly },
			{ displayName: 'Job Type ID', name: 'jobTypeId', type: 'string', default: '', displayOptions: bookOnly, description: "Optional. Empty = the business's default job type. Its default duration is used when Duration is empty." },
			{ displayName: 'Start (Business Local Time)', name: 'scheduledAt', type: 'string', default: '', required: true, placeholder: '2026-10-06T10:00:00', displayOptions: bookOnly, description: "No timezone offset — the business's own clock" },
			{ displayName: 'Duration (Minutes)', name: 'duration', type: 'number', default: 0, displayOptions: bookOnly, description: '0 = use the job type default' },
			{ displayName: 'Description', name: 'description', type: 'string', default: '', displayOptions: bookOnly },
			{ displayName: 'Job ID', name: 'jobId', type: 'string', default: '', required: true, displayOptions: { show: { operation: ['getJob'] } } },
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		const execId = this.getExecutionId();
		for (let i = 0; i < items.length; i++) {
			const op = this.getNodeParameter('operation', i) as string;
			try {
				let data: unknown;
				const p = (n: string) => this.getNodeParameter(n, i, '') as string;
				if (op === 'findCustomer') {
					if (!api.looksE164(p('phone'))) throw new NodeOperationError(this.getNode(), 'Phone must be E.164 with the leading + (e.g. +16135550142)', { itemIndex: i });
					data = await call(this, api.findCustomerByPhone(p('phone')));
				} else if (op === 'createCustomer') {
					data = await call(this, api.createCustomer({ full_name: p('fullName'), phone: p('phone'), email: p('email'), sms_opt_in: this.getNodeParameter('smsOptIn', i, false) as boolean }, api.idempotencyKey(execId, i, 'customer')));
				} else if (op === 'getJob') {
					data = await call(this, api.getJobRequest(p('jobId')));
				} else if (op === 'listJobTypes') {
					data = await call(this, api.listJobTypes());
				} else {
					const duration = this.getNodeParameter('duration', i, 0) as number;
					const input: api.BookAndConfirmInput = {
						job_type_id: p('jobTypeId') || undefined,
						scheduled_at: p('scheduledAt'),
						job_duration_minutes: duration > 0 ? duration : undefined,
						description: p('description') || undefined,
					};
					if (p('customerId')) {
						input.customer_id = p('customerId');
					} else {
						input.customer = { full_name: p('fullName'), phone: p('phone') || undefined, email: p('email') || undefined, sms_opt_in: this.getNodeParameter('smsOptIn', i, false) as boolean };
						input.address = { line: p('addressLine'), city: p('city'), state: p('state'), postal_code: p('postalCode'), country: p('country') };
					}
					data = await call(this, api.bookAndConfirm(input, api.idempotencyKey(execId, i, 'book-and-confirm')));
				}
				const rows = Array.isArray(data) ? data : [data];
				for (const r of rows) out.push({ json: r as IDataObject, pairedItem: { item: i } });
			} catch (e) {
				const err = e as Error & { errorCode?: string | number };
				if (this.continueOnFail()) {
					out.push({ json: { error: err.message, error_code: err.errorCode ?? null }, pairedItem: { item: i } });
					continue;
				}
				if (e instanceof NodeOperationError) throw new NodeOperationError(this.getNode(), err.message, { itemIndex: i });
				throw new NodeApiError(this.getNode(), { message: err.message, error_code: err.errorCode ?? null } as JsonObject, { itemIndex: i });
			}
		}
		return [out];
	}
}
