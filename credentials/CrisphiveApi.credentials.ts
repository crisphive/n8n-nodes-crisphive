import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class CrisphiveApi implements ICredentialType {
	name = 'crisphiveApi';
	displayName = 'Crisphive API';
	icon = { light: 'file:crisphive.svg', dark: 'file:crisphive.dark.svg' } as const;
	documentationUrl = 'https://docs.crisphive.com';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'chsk_test_… (sandbox data) or chsk_live_… (production). Create it in Crisphive → Developers → API keys.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.crisphive.com',
			description: 'Leave as is unless Crisphive support tells you otherwise.',
		},
	];
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
	};
	test: ICredentialTestRequest = {
		request: { baseURL: '={{$credentials.baseUrl}}', url: '/v1/job-types', qs: { limit: 1 } },
	};
}
