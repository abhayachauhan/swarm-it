// Writes backend/aws-read-ops.mjs: every AWS CLI operation that only reads, per service, taken from the AWS CLI's own service
// models (the botocore data folder inside an awscli install). Run it by hand when the AWS CLI is upgraded:
//   node scripts/gen-aws-read-ops.mjs <awscli>/botocore/data backend/aws-read-ops.mjs <awscli version>
// An operation counts as a read when its name starts with Describe, List, Get, BatchGet, Search, Lookup, Query, Scan, Select, Check,
// Validate, Simulate, Estimate, Filter or Head, and it is not on EXCLUDED. The doc text of every such operation was read once
// (2026-11-24) for ones that look like reads and are not: the model's first sentence says it creates, sends, starts or issues
// something. Those, and every one that takes an idempotency token, are on EXCLUDED unless the doc showed they only read.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// The verb must be a whole word: `CheckoutLicense` (license-manager, which takes a license) is not a `Check`.
const READ = /^(?:Describe|List|Get|BatchGet|Search|Lookup|Query|Scan|Select|Check|Validate|Simulate|Estimate|Filter|Head)(?=[A-Z0-9]|$)/;
/** Read-looking operations that change something, send a message or mint a credential or login link. Anything not here is a read. */
const EXCLUDED = new Set([
    'cognito-idp get-user-attribute-verification-code', // sends a verification code by email or text message
    'cognito-idp get-client-token', 'cognito-identity get-id', 'cognito-identity get-open-id-token', 'cognito-identity get-open-id-token-for-developer-identity',
    'iot describe-endpoint', // creates the endpoint when there is none
    'iot get-registration-code', 'lambda checkpoint-durable-execution', 'stepfunctions get-activity-task', 'xray get-sampling-targets',
    'sagemaker get-scaling-configuration-recommendation', 'ssm get-execution-preview', 'glue get-mapping', 'quicksight describe-topic-refresh-schedule',
    'emr-containers get-managed-endpoint-session-credentials', 'bedrock-agentcore get-resource-payment-token', 'payment-cryptography get-certificate-signing-request',
    'redshift get-identity-center-auth-token', 'redshift get-cluster-credentials', 'redshift get-cluster-credentials-with-iam', 'redshift-serverless get-credentials',
    'quicksight get-dashboard-embed-url', 'quicksight get-session-embed-url', 'marketplace-reporting get-buyer-dashboard',
    'security-ir get-case-attachment-upload-url', 'auditmanager get-evidence-file-upload-url', 'datazone get-iam-portal-login-url',
    'connectparticipant get-authentication-url', 'emr-serverless get-dashboard-for-job-run'
]);
/** Operations that mint a credential, token, session or link: left for the user, except the few people run all day. A `list-` or `describe-` is never one. */
// A qualifier may follow (`get-credentials-for-identity`, `get-tokens-from-refresh-token`, `get-workload-access-token-for-jwt`). A URL that only
// downloads data (`get-download-url-for-layer`, `get-assessment-report-url`) is a read, so it stays.
const MINTS = /^get-.*(?:credentials|access-token|auth-token|federation-token|presigned-url|access-details|login-url|embed-url|upload-url|oauth2-token|payment-token|tokens|session-url|signed-[a-z0-9-]*url)(?:-(?:for|from)-[a-z0-9-]+)?$/;
const KEEP_MINTS = new Set(['codeartifact get-authorization-token', 'ecr get-authorization-token', 'ecr-public get-authorization-token', 'sso get-role-credentials']);
/** Commands the AWS CLI adds on top of its service models that only read. */
const CUSTOM = { logs: ['tail'], eks: ['get-token'], ecr: ['get-login-password'], cloudtrail: ['validate-logs'] };
/** A read that carries an idempotency token for retries and changes nothing. */
const TOKEN_READS = new Set(['fsx describe-file-system-aliases', 'timestream-query query', 'bedrock-agentcore get-agent-card']);

const kebab = name => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').toLowerCase();
const [data, out, version] = process.argv.slice(2);
if (!data || !out) { console.error('usage: node scripts/gen-aws-read-ops.mjs <botocore data folder> <output file> [awscli version]'); process.exit(2); }

const services = {};
for (const dir of readdirSync(data).sort()) {
    let versions;
    try { versions = readdirSync(join(data, dir)).filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v)).sort(); } catch { continue; }
    const file = versions.length ? join(data, dir, versions.at(-1), 'service-2.json') : '';
    if (!file || !existsSync(file)) continue;
    const model = JSON.parse(readFileSync(file, 'utf8'));
    const cli = dir === 's3' ? 's3api' : dir;
    const ops = new Set(CUSTOM[cli] ?? []);
    for (const [name, op] of Object.entries(model.operations ?? {})) {
        const full = `${cli} ${kebab(name)}`;
        // Every sts call only returns credentials or identity; none changes anything in an account.
        if (cli === 'sts') { ops.add(kebab(name)); continue; }
        if (!READ.test(name) || EXCLUDED.has(full) || (MINTS.test(kebab(name)) && !KEEP_MINTS.has(full))) continue;
        const input = op.input ? model.shapes?.[op.input.shape] : null;
        if (Object.values(input?.members ?? {}).some(m => m.idempotencyToken) && !TOKEN_READS.has(full)) continue;
        ops.add(kebab(name));
    }
    if (ops.size) services[cli] = [...ops].sort().join(' ');
}
const body = Object.entries(services).map(([service, ops]) => `    ${JSON.stringify(service)}: ${JSON.stringify(ops)}`).join(',\n');
writeFileSync(out, `// Generated by scripts/gen-aws-read-ops.mjs from the AWS CLI ${version ?? ''} service models. Do not edit by hand: change the script and run it again.
// Every AWS CLI operation that only reads, by service. An operation or service not listed here is not known to be a read.
export const AWS_READ_OPS = new Map(Object.entries({
${body}
}).map(([service, ops]) => [service, new Set(ops.split(' '))]));
`);
console.error(`${Object.keys(services).length} services, ${Object.values(services).reduce((n, o) => n + o.split(' ').length, 0)} operations`);
