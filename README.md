# n8n-nodes-crisphive

[Crisphive](https://crisphive.com) nodes for [n8n](https://n8n.io): constraint-based
scheduling for field operations on a deterministic solver — find a caller, book and
confirm a job in one call, and start workflows when jobs and customers change.

## Installation

In n8n: **Settings → Community Nodes → Install** and enter `n8n-nodes-crisphive`.
See n8n's [community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

Create an API key in Crisphive (**Developers → API keys**) and add an n8n credential of
type **Crisphive API**:

| Field | Value |
|---|---|
| API Key | `chsk_test_…` (sandbox data, safe to experiment) or `chsk_live_…` (production) |
| Base URL | leave `https://api.crisphive.com` |

Restrict the key to what your workflows need, e.g. `customers_view`, `customers_manage`,
`job_view`, `job_create`, `job_manage`.

## Nodes

**Crisphive** (action node, also usable as an AI Agent tool)

| Operation | What it does |
|---|---|
| Book and Confirm Job | Books, schedules and confirms a job at a chosen time in one call. Required: **Start** and, under **Customer**, either an **Existing Customer ID** or a **New or Returning Caller** (Full Name + Address Line, plus a Phone or Email under Additional Fields — the caller is matched or created). Job Type, Duration, Description and the rest of the address are Additional Fields; an empty job type uses the business's default type and its default duration. If no technician can take that time the job is still **saved** and `confirmed` is `false` — route it to a person; do not rerun with a new execution. |
| Find Customer by Phone | Exact match on an E.164 number (`+16135550142`). |
| Create Customer | Adds a customer. Required: Full Name; a Phone or an Email under Additional Fields. |
| Get Job | Reads one job. |
| List Job Types | The business's job types and their default durations. |

Writes carry an `Idempotency-Key` derived from the n8n execution and item, so n8n's
own retry of an execution replays the original booking instead of creating a second one.

**Crisphive Trigger** (instant)

Starts the workflow on the Crisphive events you pick. The list is read live from Crisphive,
so new events appear without an update to this node. Activating the workflow registers a webhook in
Crisphive; deactivating removes it. Every delivery is checked against its
`Crisphive-Signature` (HMAC-SHA256, 5-minute window) and refused otherwise. Job events
are followed by a read of the full job unless **Fetch Full Job** is off.

Triggers must be connected by someone with Developer access in Crisphive, usually the Owner
(a credential without it can still run the Crisphive node's actions).

The subscription's signing secret lasts 365 days, after which Crisphive disables the
endpoint and emails the business Owner; deactivating and reactivating the workflow
subscribes again.

## Times

`Start (Business Local Time)` is the business's own wall clock with no offset, e.g.
`2026-10-06T10:00:00`.

## Compatibility

Type-checked against n8n-workflow 2.x and exercised end to end against the Crisphive API (the adapter E2E in the source repository). Node.js 20.15 or later.

## Resources

- Crisphive developer docs: https://docs.crisphive.com
- API reference: https://api.crisphive.com/developers/openapi.json

## License

MIT
