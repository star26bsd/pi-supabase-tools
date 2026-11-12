// Constructed from pinned upstream source, NOT recorded stack output.
// Provenance, substitutions and live-verification limits: doc/CLI-COMPATIBILITY.md.
const listener = "Serving functions on http://127.0.0.1:54321/functions/v1/<function-name>\n";
const commonEnvironment = [
  'ANON_KEY="synthetic-anon-key"',
  'API_URL="http://127.0.0.1:54321"',
  'DB_URL="postgresql://postgres:synthetic-password@127.0.0.1:54322/postgres"',
  'INBUCKET_URL="http://127.0.0.1:54324"',
  'JWT_SECRET="synthetic-unmapped-jwt-secret"',
];

export const cliV2Contracts = [
  {
    version: "2.111.0",
    listener,
    statusStdout: [...commonEnvironment, 'SERVICE_ROLE_KEY="synthetic-service-key"'].join("\n") + "\n",
    statusStderr: "Stopped services: [supabase_analytics_fixture]\n",
  },
  {
    version: "2.122.1",
    listener,
    statusStdout: [
      ...commonEnvironment,
      'LINKED_PROJECT_NAME="Synthetic Project"',
      'LINKED_PROJECT_REF="synthetic-project-ref"',
      'MAILPIT_URL="http://127.0.0.1:54324"',
      'SERVICE_ROLE_KEY="synthetic-service-key"',
    ].join("\n") + "\n",
    statusStderr: "Stopped services: [supabase_analytics_fixture]\n"
      + "WARN: INBUCKET_URL is deprecated and will be removed in v3, use MAILPIT_URL instead.\n",
  },
] as const;
