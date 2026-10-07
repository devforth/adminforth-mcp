<template>
  <div class="af-mcp-settings flex flex-col justify-center mr-6 md:mr-12">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-3xl font-semibold leading-none text-gray-800 dark:text-gray-50">
          {{ $t('MCP Settings') }}
        </h2>
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">
          {{ $t('Connect an AI agent to {brand}. It acts on your behalf with your permissions.', { brand: brandName }) }}
        </p>
      </div>
      <Button @click="openConnectDialog">
        {{ $t('Connect agent') }}
      </Button>
    </div>

    <Table
      class="mt-6"
      :columns="columns"
      :data="authSecrets"
      :isLoading="loading"
      :pageSize="10"
    >
      <template #cell:name="{ item }">
        <p class="font-medium text-gray-900 dark:text-white">{{ item.name }}</p>
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          {{ item.oauthClientId ? `${$t('OAuth')} · ${oauthClientHost(item.oauthClientId)}` : $t('Auth secret') }} · {{ formatDateTime(item.createdAt) }}
        </p>
      </template>

      <template #cell:lastUsedByAgent="{ item }">
        <div v-if="item.lastUsedByAgent" class="flex items-center gap-2">
          <img v-if="describeAgent(item.lastUsedByAgent).icon" :src="describeAgent(item.lastUsedByAgent).icon" class="h-5 w-5" alt="" />
          <span>{{ describeAgent(item.lastUsedByAgent).label }}</span>
        </div>
        <span v-else class="text-gray-400">{{ $t('Not used yet') }}</span>
      </template>

      <template #cell:lastUsedAt="{ item }">
        {{ item.lastUsedAt ? formatDateTime(item.lastUsedAt) : $t('Never') }}
      </template>

      <template #cell:actions="{ item }">
        <div class="flex justify-end">
          <Button
            variant="danger"
            :loader="revokingId === item.id"
            :disabled="revokingId === item.id"
            @click="revoke(item)"
          >
            {{ revokingId === item.id ? $t('Revoking') : $t('Revoke') }}
          </Button>
        </div>
      </template>
    </Table>

    <Dialog
      ref="dialogRef"
      class="w-full max-w-3xl"
      :header="$t('Connect an AI agent')"
      :buttons="dialogButtons"
    >
      <!-- mounted once the list is loaded: ButtonGroup reads its buttons only on mount -->
      <ButtonGroup v-if="oauthEnabled" v-model="activeClient">
        <template v-for="client in CLIENTS" :key="client" #[`button:${client}`]>
          <span class="px-4 py-2">{{ client }}</span>
        </template>
      </ButtonGroup>

      <template v-if="showsCreatedSecret">
        <p class="mt-4 text-sm text-amber-700 dark:text-amber-300">{{ $t('Copy it now. You will not be able to view it again.') }}</p>
        <p class="mt-3 rounded-default border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          {{ $t('This secret lets an agent do everything you can do in the admin panel, including deleting data and changing your security settings. Keep it like a password, give it to one agent only, and revoke it if that agent or its device is compromised.') }}
        </p>
      </template>

      <div v-for="step in activeSteps" :key="step.snippet" class="mt-4">
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ step.hint }}</p>
        <div class="mt-2 flex items-start gap-2">
          <code class="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-default bg-gray-100 px-3 py-2 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-100">{{ step.snippet }}</code>
          <Button variant="secondary" @click="copy(step.snippet, $t('Copied'))">
            {{ $t('Copy') }}
          </Button>
        </div>
      </div>

      <!-- enter is handled on the wrapper so it fires once: Input spreads attrs on both its root and the input -->
      <div v-if="activeClient === 'Other' && !createdSecret" class="mt-4" @keydown.enter="createAuthSecret">
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ $t('Use one auth secret for one agent.') }}</p>
        <label class="mt-5 block text-sm font-medium text-gray-700 dark:text-gray-200">{{ $t('Secret name') }}</label>
        <div class="mt-2">
          <Input v-model="secretName" type="text" fullWidth placeholder="Claude Code" />
        </div>
      </div>

      <template v-if="showsCreatedSecret">
        <p class="mt-5 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">{{ $t('Prompt for your agent') }}</p>
        <pre class="mt-2 whitespace-pre-wrap rounded-default bg-gray-100 p-3 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-100">{{ setupPrompt }}</pre>
      </template>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, ButtonGroup, Dialog, Input, Table } from '@/afcl';
import { useCoreStore } from '@/stores/core';
import adminforth from '@/adminforth';
import { callAdminForthApi, formatDateTime } from '@/utils';
import claudeCodeIcon from './icons/claude-code.svg';
import codexIcon from './icons/codex.svg';
import geminiIcon from './icons/gemini.svg';

type Agent = { client: string; ver: string | null };
type AuthSecret = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedByAgent: Agent | null;
  oauthClientId: string | null;
};
type Client = typeof CLIENTS[number];

const CLIENTS = ['Claude Code', 'Codex', 'Other'] as const;
const NON_SERVER_NAME_CHARACTER_RE = /[^a-z0-9]+/g;
const EDGE_HYPHEN_RE = /^-+|-+$/g;

const { t } = useI18n();
const coreStore = useCoreStore();
const brandName = computed<string>(() => coreStore.config?.brandName);
const activeClient = ref<Client>('Claude Code');
// Without OAuth sign-in the agents connect only with auth secrets, so the dialog is the Other tab alone.
const oauthEnabled = ref(false);
// Built by the plugin from adminPanelOrigin: OAuth accepts tokens only for this exact URL. Without adminPanelOrigin
// there is no OAuth and auth secrets do not check the URL, so the address this page was opened at is shown.
const mcpUrl = ref('');

const authSecrets = ref<AuthSecret[]>([]);
const loading = ref(true);
const dialogRef = ref();
const secretName = ref('');
const createdSecret = ref('');
const creating = ref(false);
const revokingId = ref<string | null>(null);

const columns = computed(() => [
  { label: t('Name'), fieldName: 'name', sortable: true },
  { label: t('Last used by'), fieldName: 'lastUsedByAgent' },
  { label: t('Last usage'), fieldName: 'lastUsedAt', sortable: true },
  { label: t('Actions'), fieldName: 'actions' },
]);

const closeButton = computed(() => ({
  label: t('Close'),
  options: { variant: 'secondary' },
  onclick: (dialog: { hide: () => void }) => dialog.hide(),
}));
const dialogButtons = computed(() => {
  if (activeClient.value !== 'Other') return [closeButton.value];
  if (createdSecret.value) {
    return [
      {
        label: t('Copy prompt'),
        options: { variant: 'secondary' },
        onclick: () => copy(setupPrompt.value, t('Prompt copied')),
      },
      {
        label: t('Done'),
        onclick: (dialog: { hide: () => void }) => dialog.hide(),
      },
    ];
  }
  return [
    {
      label: t('Cancel'),
      options: { variant: 'secondary' },
      onclick: (dialog: { hide: () => void }) => dialog.hide(),
    },
    {
      label: creating.value ? t('Creating') : t('Create'),
      options: { loader: creating.value, disabled: creating.value || !secretName.value.trim() },
      onclick: () => createAuthSecret(),
    },
  ];
});

function fallbackMcpUrl() {
  const baseUrl = (import.meta.env.VITE_ADMINFORTH_PUBLIC_PATH || '').replace(/\/$/, '');
  return `${window.location.origin}${baseUrl}/adminapi/v1/mcp`;
}
// Name the MCP server is registered under in the agent, e.g. `claude mcp add ... my-admin <url>`.
// A brand name of non-Latin letters only leaves an empty slug, hence the default.
const serverName = computed(() => brandName.value
  .toLowerCase()
  .replace(NON_SERVER_NAME_CHARACTER_RE, '-')
  .replace(EDGE_HYPHEN_RE, '') || 'adminforth');
const clientSteps = computed<Record<Client, { hint: string; snippet: string }[]>>(() => ({
  'Claude Code': [
    { hint: t('Run in your terminal.'), snippet: `claude mcp add --transport http ${serverName.value} ${mcpUrl.value}` },
    {
      hint: t('Then run in Claude Code, pick {name} and choose Authenticate.', { name: serverName.value }),
      snippet: '/mcp',
    },
  ],
  Codex: [{
    hint: t('Run in your terminal. Codex opens the admin panel in your browser to sign in; if it does not, run codex mcp login {name}.', { name: serverName.value }),
    snippet: `codex mcp add ${serverName.value} --url ${mcpUrl.value}`,
  }],
  // Other shows the URL and the secret only once a secret is created; before that it is the create form.
  Other: createdSecret.value
    ? [
        { hint: t('MCP server URL'), snippet: mcpUrl.value },
        { hint: t('Auth secret'), snippet: `Bearer ${createdSecret.value}` },
      ]
    : [],
}));
const activeSteps = computed(() => clientSteps.value[activeClient.value]);
const showsCreatedSecret = computed(() => activeClient.value === 'Other' && !!createdSecret.value);
const setupPrompt = computed(() => [
  'Add this remote MCP server to the current agent:',
  `URL: ${mcpUrl.value}`,
  `Header: Authorization: Bearer ${createdSecret.value || '<secret>'}`,
  'Use this auth secret only for this agent.',
].join('\n'));

// OAuth connections are made in another tab (the consent page) or in the agent, so the list is refreshed
// when the user comes back to this one.
onMounted(() => {
  loadAuthSecrets();
  window.addEventListener('focus', loadAuthSecrets);
});
onBeforeUnmount(() => window.removeEventListener('focus', loadAuthSecrets));

// Only the first load shows the loading state; later refreshes swap the rows in place.
async function loadAuthSecrets() {
  try {
    const response = await callAdminForthApi({ method: 'GET', path: '/mcp/auth-secrets' });
    if (response) {
      authSecrets.value = response.authSecrets;
      if (!response.oauthEnabled) activeClient.value = 'Other';
      oauthEnabled.value = response.oauthEnabled;
      mcpUrl.value = response.mcpUrl ?? fallbackMcpUrl();
    }
  } finally {
    loading.value = false;
  }
}

function openConnectDialog() {
  secretName.value = '';
  createdSecret.value = '';
  dialogRef.value?.open();
}

async function createAuthSecret() {
  if (creating.value || !secretName.value.trim()) return;
  creating.value = true;
  try {
    const response = await callAdminForthApi({
      method: 'POST',
      path: '/mcp/auth-secrets',
      body: { name: secretName.value.trim() },
    });
    if (response?.secret) {
      createdSecret.value = response.secret;
      await loadAuthSecrets();
    }
  } finally {
    creating.value = false;
  }
}

async function revoke(authSecret: AuthSecret) {
  const confirmed = await adminforth.confirm({
    message: t('Revoke access of "{name}"? Any agent using it will lose access.', { name: authSecret.name }),
    yes: t('Revoke'),
    no: t('Cancel'),
    dangerous: true,
  });
  if (!confirmed) return;
  revokingId.value = authSecret.id;
  try {
    await callAdminForthApi({ method: 'DELETE', path: '/mcp/auth-secrets', body: { id: authSecret.id } });
    await loadAuthSecrets();
  } finally {
    revokingId.value = null;
  }
}

// client_id is a metadata document URL; a client configured in devOAuthClients may have a plain id.
function oauthClientHost(clientId: string) {
  return URL.parse(clientId)?.host ?? clientId;
}

function describeAgent(agent: Agent) {
  const client = agent.client;
  let name = client.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  let icon: string | null = null;
  if (client.includes('claude') && client.includes('code')) {
    name = 'Claude Code';
    icon = claudeCodeIcon;
  } else if (client.includes('claude')) {
    name = 'Claude';
    icon = claudeCodeIcon;
  } else if (client.includes('codex') || client.includes('openai') || client === 'undici') {
    name = 'Codex';
    icon = codexIcon;
  } else if (client.includes('gemini')) {
    name = 'Gemini';
    icon = geminiIcon;
  }
  return { label: agent.ver ? `${name} v${agent.ver}` : name, icon };
}

async function copy(value: string, message: string) {
  await navigator.clipboard.writeText(value);
  adminforth.alert({ message, variant: 'success' });
}
</script>
