import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	IHttpRequestOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';
import * as api from '../../lib/crisphive';

interface SubscribedEndpoint {
	id: string;
	secret?: string;
}

async function call(ctx: IHookFunctions, spec: api.RequestSpec): Promise<unknown> {
	const creds = await ctx.getCredentials('crisphiveApi');
	const opts: IHttpRequestOptions = {
		method: spec.method,
		baseURL: (creds.baseUrl as string) || api.DEFAULT_BASE_URL,
		url: spec.path,
		body: spec.body as IDataObject,
		headers: spec.headers,
		json: true,
		ignoreHttpStatusErrors: true,
	};
	return api.unwrap(await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'crisphiveApi', opts));
}

// Instant trigger over Crisphive's webhook REST-hook triple: activating the
// workflow subscribes (POST /v1/webhooks), deactivating unsubscribes
// (DELETE /v1/webhooks/{id}). Every delivery must carry a valid
// Crisphive-Signature for this subscription's secret; the subscribe-time
// `ping` is answered and dropped.
export class CrisphiveTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Crisphive Trigger',
		name: 'crisphiveTrigger',
		icon: { light: 'file:crisphive.svg', dark: 'file:crisphive.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when a Crisphive job or customer event happens',
		defaults: { name: 'Crisphive Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'crisphiveApi', required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
		properties: [
			{
				displayName: 'Event Names or IDs',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['job_request.completed'],
				// Read from GET /v1/webhooks/event-types, so a new Crisphive
				// event appears here without a new release of this node.
				typeOptions: { loadOptionsMethod: 'getEventTypes' },
				description: 'Which Crisphive events start the workflow. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Fetch Full Job',
				name: 'hydrate',
				type: 'boolean',
				default: true,
				description: 'Whether job events should be followed by GET /v1/job-requests/{ID} (the event itself carries only ID, short code and status)',
			},
		],
	};

	methods = {
		loadOptions: {
			async getEventTypes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const creds = await this.getCredentials('crisphiveApi');
				const spec = api.listWebhookEventTypes();
				const res = await this.helpers.httpRequestWithAuthentication.call(this, 'crisphiveApi', {
					method: spec.method,
					baseURL: (creds.baseUrl as string) || api.DEFAULT_BASE_URL,
					url: spec.path,
					json: true,
					ignoreHttpStatusErrors: true,
				});
				return api.eventOptions(api.unwrap(res));
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return Boolean(this.getWorkflowStaticData('node').webhookId);
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const url = this.getNodeWebhookUrl('default') as string;
				const events = this.getNodeParameter('events') as string[];
				const key = api.subscribeKey(`n8n-sub-${this.getWorkflow().id}-${this.getNode().id}`, String(Date.now()));
				const ep = (await call(this, api.subscribeWebhook(url, events, key))) as SubscribedEndpoint;
				const data = this.getWorkflowStaticData('node');
				data.webhookId = ep.id;
				// Shown once by Crisphive; every delivery is verified against it.
				data.webhookSecret = ep.secret;
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (data.webhookId) {
					try {
						await call(this, api.unsubscribeWebhook(data.webhookId as string));
					} catch (e) {
						// Already gone (deleted on the dashboard) is fine.
						const err = e as api.CrisphiveApiError;
						if (err.errorCode !== 'WEBHOOK_NOT_FOUND') {
							throw new NodeApiError(this.getNode(), { message: err.message, error_code: err.errorCode ?? null } as JsonObject);
						}
					}
					delete data.webhookId;
					delete data.webhookSecret;
				}
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData();
		if (api.isPing(body)) return { workflowData: undefined };
		const req = this.getRequestObject();
		const secret = this.getWorkflowStaticData('node').webhookSecret as string | undefined;
		// The signature covers the exact bytes sent; re-serialising the parsed
		// body would never match, so a request without rawBody is refused too.
		const raw = (req as unknown as { rawBody?: Buffer | string }).rawBody;
		if (!secret || raw === undefined || !api.verifySignature(raw, req.header('crisphive-signature'), secret, Math.floor(Date.now() / 1000))) {
			// Not signed by Crisphive with this subscription's secret: refuse it
			// rather than start the workflow on a forged event.
			this.getResponseObject().status(401).send('invalid signature').end();
			return { noWebhookResponse: true };
		}
		const evt = api.eventFromWebhook(body);
		if (!evt) return { workflowData: undefined };
		let object: IDataObject = evt.object as IDataObject;
		if (this.getNodeParameter('hydrate', true) && evt.type.startsWith('job_request.') && object.id) {
			const creds = await this.getCredentials('crisphiveApi');
			const res = await this.helpers.httpRequestWithAuthentication.call(this, 'crisphiveApi', {
				method: 'GET',
				baseURL: (creds.baseUrl as string) || api.DEFAULT_BASE_URL,
				url: `/v1/job-requests/${encodeURIComponent(String(object.id))}`,
				json: true,
				ignoreHttpStatusErrors: true,
			});
			try {
				object = api.unwrap(res) as IDataObject;
			} catch {
				/* keep the thin object if the job cannot be read */
			}
		}
		return { workflowData: [[{ json: { event_id: evt.id, type: evt.type, object } }]] };
	}
}
