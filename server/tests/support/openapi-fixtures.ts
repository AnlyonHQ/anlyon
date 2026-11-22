const form = (properties: Record<string, unknown>, required: string[] = [], deep: string[] = []) => ({
  required: true,
  content: {
    "application/x-www-form-urlencoded": {
      schema: { type: "object", properties, ...(required.length ? { required } : {}) },
      encoding: Object.fromEntries(deep.map((name) => [name, { style: "deepObject", explode: true }])),
    },
  },
});

const json = (properties: Record<string, unknown>, required: string[] = []) => ({
  required: true,
  content: { "application/json": { schema: { type: "object", properties, ...(required.length ? { required } : {}) } } },
});

const pathParam = (name: string) => ({ name, in: "path", required: true, schema: { type: "string", maxLength: 5000 } });
const metadata = { type: "object", additionalProperties: true };

export const stripeLike = {
  openapi: "3.0.0",
  info: { title: "Stripe API", version: "2024-06-20" },
  servers: [{ url: "https://api.stripe.com/" }],
  paths: {
    "/v1/charges": {
      get: { operationId: "GetCharges", summary: "List all charges" },
      post: {
        operationId: "PostCharges",
        summary: "Create a charge",
        requestBody: form(
          {
            amount: { type: "integer", description: "Amount intended to be collected, in the smallest currency unit." },
            currency: { type: "string", format: "currency" },
            customer: { type: "string", maxLength: 500 },
            description: { type: "string", maxLength: 40000 },
            metadata,
          },
          ["amount", "currency"],
          ["metadata"],
        ),
      },
    },
    "/v1/charges/{charge}": {
      post: {
        operationId: "PostChargesCharge",
        summary: "Update a charge",
        parameters: [pathParam("charge")],
        requestBody: form({ description: { type: "string" }, metadata }, [], ["metadata"]),
      },
    },
    "/v1/charges/{charge}/capture": {
      post: {
        operationId: "PostChargesChargeCapture",
        summary: "Capture a payment",
        parameters: [pathParam("charge")],
        requestBody: form({ amount: { type: "integer" }, receipt_email: { type: "string" } }),
      },
    },
    "/v1/refunds": {
      post: {
        operationId: "PostRefunds",
        summary: "Create customer balance refund",
        requestBody: form({
          charge: { type: "string", maxLength: 5000 },
          amount: { type: "integer" },
          currency: { type: "string", format: "currency" },
          reason: { type: "string", enum: ["duplicate", "fraudulent", "requested_by_customer"] },
        }),
      },
    },
    "/v1/payouts": {
      post: {
        operationId: "PostPayouts",
        summary: "Create a payout",
        requestBody: form({ amount: { type: "integer" }, currency: { type: "string" }, destination: { type: "string" } }, ["amount", "currency"]),
      },
    },
    "/v1/transfers": {
      post: {
        operationId: "PostTransfers",
        summary: "Create a transfer",
        requestBody: form({ amount: { type: "integer" }, currency: { type: "string" }, destination: { type: "string" } }, ["currency", "destination"]),
      },
    },
    "/v1/payment_methods": {
      post: {
        operationId: "PostPaymentMethods",
        summary: "Shares a PaymentMethod",
        requestBody: form({ type: { type: "string", enum: ["card", "us_bank_account"] }, customer: { type: "string" } }),
      },
    },
    "/v1/customers": {
      post: {
        operationId: "PostCustomers",
        summary: "Create a customer",
        requestBody: form({ email: { type: "string", maxLength: 512 }, name: { type: "string", maxLength: 256 }, balance: { type: "integer" } }),
      },
    },
    "/v1/customers/{customer}": {
      delete: { operationId: "DeleteCustomersCustomer", summary: "Delete a customer", parameters: [pathParam("customer")] },
    },
    "/v1/invoices/{invoice}/pay": {
      post: { operationId: "PostInvoicesInvoicePay", summary: "Pay an invoice", parameters: [pathParam("invoice")], requestBody: form({ paid_out_of_band: { type: "boolean" } }) },
    },
    "/v1/invoices/{invoice}/void": {
      post: { operationId: "PostInvoicesInvoiceVoid", summary: "Void an invoice", parameters: [pathParam("invoice")] },
    },
    "/v1/subscriptions/{subscription_exposed_id}": {
      delete: { operationId: "DeleteSubscriptionsSubscriptionExposedId", summary: "Cancel a subscription", parameters: [pathParam("subscription_exposed_id")] },
    },
  },
};

const ownerRepo = [pathParam("owner"), pathParam("repo")];

export const githubLike = {
  openapi: "3.0.3",
  info: { title: "GitHub v3 REST API", version: "1.1.4" },
  servers: [{ url: "https://api.github.com" }],
  paths: {
    "/repos/{owner}/{repo}/issues": {
      get: {
        operationId: "issues/list-for-repo",
        summary: "List repository issues",
        parameters: ownerRepo,
        "x-github": { githubCloudOnly: false, enabledForGitHubApps: true, category: "issues", subcategory: "issues" },
      },
      post: {
        operationId: "issues/create",
        summary: "Create an issue",
        parameters: ownerRepo,
        requestBody: json({ title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } }, assignees: { type: "array", items: { type: "string" } } }, ["title"]),
      },
    },
    "/repos/{owner}/{repo}/issues/{issue_number}": {
      patch: {
        operationId: "issues/update",
        summary: "Update an issue",
        parameters: [...ownerRepo, pathParam("issue_number")],
        requestBody: json({ title: { type: "string" }, state: { type: "string", enum: ["open", "closed"] } }),
      },
    },
    "/repos/{owner}/{repo}/issues/{issue_number}/comments": {
      post: {
        operationId: "issues/create-comment",
        summary: "Create an issue comment",
        parameters: [...ownerRepo, pathParam("issue_number")],
        requestBody: json({ body: { type: "string" } }, ["body"]),
      },
    },
    "/repos/{owner}/{repo}/pulls/{pull_number}/merge": {
      put: {
        operationId: "pulls/merge",
        summary: "Merge a pull request",
        parameters: [...ownerRepo, pathParam("pull_number")],
        requestBody: json({ commit_title: { type: "string" }, merge_method: { type: "string", enum: ["merge", "squash", "rebase"] } }),
      },
    },
    "/repos/{owner}/{repo}/transfer": {
      post: {
        operationId: "repos/transfer",
        summary: "Transfer a repository",
        parameters: ownerRepo,
        requestBody: json({ new_owner: { type: "string" }, new_name: { type: "string" } }, ["new_owner"]),
      },
    },
    "/repos/{owner}/{repo}": {
      delete: { operationId: "repos/delete", summary: "Delete a repository", parameters: ownerRepo },
    },
    "/repos/{owner}/{repo}/git/refs/{ref}": {
      delete: { operationId: "git/delete-ref", summary: "Delete a reference", parameters: [...ownerRepo, pathParam("ref")] },
    },
    "/user/emails": {
      post: {
        operationId: "users/add-email-for-authenticated-user",
        summary: "Add an email address for the authenticated user",
        requestBody: json({ emails: { type: "array", items: { type: "string" } } }, ["emails"]),
      },
    },
  },
};

const hubspotObject = { type: "object", properties: { properties: { type: "object", additionalProperties: true } }, required: ["properties"] };

export const crmLike = {
  openapi: "3.0.1",
  info: { title: "CRM", version: "v3" },
  servers: [{ url: "https://api.hubapi.com" }],
  paths: {
    "/crm/v3/objects/contacts": {
      get: { operationId: "get-/crm/v3/objects/contacts_getPage", summary: "List" },
      post: {
        operationId: "post-/crm/v3/objects/contacts_create",
        summary: "Create",
        requestBody: { required: true, content: { "application/json": { schema: hubspotObject } } },
      },
    },
    "/crm/v3/objects/contacts/{contactId}": {
      patch: {
        operationId: "patch-/crm/v3/objects/contacts/{contactId}_update",
        summary: "Update",
        parameters: [pathParam("contactId")],
        requestBody: { required: true, content: { "application/json": { schema: hubspotObject } } },
      },
      delete: { operationId: "delete-/crm/v3/objects/contacts/{contactId}_archive", summary: "Archive", parameters: [pathParam("contactId")] },
    },
    "/crm/v3/objects/contacts/batch/create": {
      post: {
        operationId: "post-/crm/v3/objects/contacts/batch/create_create",
        summary: "Create a batch of contacts",
        requestBody: json({ inputs: { type: "array", items: hubspotObject } }, ["inputs"]),
      },
    },
    "/crm/v3/objects/contacts/batch/archive": {
      post: {
        operationId: "post-/crm/v3/objects/contacts/batch/archive_archive",
        summary: "Archive a batch of contacts by ID",
        requestBody: json({ inputs: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } }, ["inputs"]),
      },
    },
    "/crm/v3/objects/deals": {
      post: {
        operationId: "post-/crm/v3/objects/deals_create",
        summary: "Create",
        requestBody: json({ properties: { type: "object", properties: { dealname: { type: "string" }, amount: { type: "string" }, deal_currency_code: { type: "string" } } } }),
      },
    },
    "/crm/v3/objects/emails": {
      post: {
        operationId: "post-/crm/v3/objects/emails_create",
        summary: "Create",
        requestBody: { required: true, content: { "application/json": { schema: hubspotObject } } },
      },
    },
    "/marketing/v3/transactional/single-email/send": {
      post: {
        operationId: "post-/marketing/v3/transactional/single-email/send_sendEmail",
        summary: "Send a single transactional email asynchronously.",
        requestBody: json(
          {
            emailId: { type: "integer" },
            message: {
              type: "object",
              properties: {
                to: { type: "string" },
                from: { type: "string" },
                cc: { type: "array", items: { type: "string" } },
                bcc: { type: "array", items: { type: "string" } },
              },
            },
          },
          ["emailId", "message"],
        ),
      },
    },
  },
};
