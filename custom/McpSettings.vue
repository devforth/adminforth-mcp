<template>
  <div class="af-mcp-settings flex flex-col">
    <PageHeader
      :title="$t('MCP')"
      :description="$t('Connect an AI agent to {brand}. It acts on your behalf with your permissions.', { brand: brandName })"
    >
      <template #actions>
        <Button class="af-mcp-connect-button" @click="openConnectDialog">
          <IconPlus class="w-4 h-4" aria-hidden="true" />
          {{ $t('Connect agent') }}
        </Button>
      </template>
    </PageHeader>

    <Table
      class="mt-6"
      :columns="columns"
      :data="authSecrets"
      :isLoading="loading"
      :pageSize="10"
    >
      <template #cell:name="{ item }">
        <p class="font-medium text-lightFormFieldTextColor dark:text-darkFormFieldTextColor">{{ item.name }}</p>
        <p class="mt-0.5 text-xs text-lightInputIconColor dark:text-darkInputIconColor">
          {{ item.oauthClientId ? `${$t('OAuth')} · ${oauthClientHost(item.oauthClientId)}` : $t('Auth secret') }} · {{ formatDateTime(item.createdAt) }}
        </p>
      </template>

      <template #cell:readOnly="{ item }">
        <Toggle
          :modelValue="serverReadOnly || item.readOnly"
          :disabled="serverReadOnly || updatingId === item.id"
          @update:modelValue="setReadOnly(item, $event)"
        />
      </template>

      <template #cell:lastUsedByAgent="{ item }">
        <div v-if="item.lastUsedByAgent" class="flex items-center gap-2">
          <img v-if="describeAgent(item.lastUsedByAgent).icon" :src="describeAgent(item.lastUsedByAgent).icon" class="h-5 w-5" alt="" />
          <span>{{ describeAgent(item.lastUsedByAgent).label }}</span>
        </div>
        <span v-else class="text-lightInputPlaceholderText dark:text-darkInputPlaceholderText">{{ $t('Not used yet') }}</span>
      </template>

      <template #cell:lastUsedAt="{ item }">
        <template v-if="item.lastUsedAt">{{ formatDateTime(item.lastUsedAt) }}</template>
        <span v-else class="text-lightInputPlaceholderText dark:text-darkInputPlaceholderText">{{ $t('Never') }}</span>
      </template>

      <template #cell:actions="{ item }">
        <div class="flex justify-end">
          <Button
            class="af-mcp-revoke-button"
            variant="secondary"
            size="sm"
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
      class="af-mcp-connect-dialog w-full max-w-3xl"
      :header="$t('Connect an AI agent')"
      :buttons="dialogButtons"
    >
      <ButtonGroup v-model="activeClient">
        <template v-for="client in CLIENTS" :key="client" #[`button:${client}`]>
          <span class="px-3.5 py-1.5">{{ client }}</span>
        </template>
      </ButtonGroup>

      <template v-if="showsCreatedSecret">
        <p class="mt-4 text-sm font-medium text-lightWarning dark:text-darkWarning">{{ $t('Copy it now. You will not be able to view it again.') }}</p>
        <div class="mt-3 flex items-start gap-2 rounded-default border border-lightWarningBorder bg-lightWarningSoft p-3 text-sm text-lightWarning dark:border-darkWarningBorder dark:bg-darkWarningSoft dark:text-darkWarning">
          <IconTriangleAlert class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p v-if="createdSecretReadOnly">
            {{ $t('This secret lets an agent read all data you can see in the admin panel. Keep it like a password, give it to one agent only, and revoke it if that agent or its device is compromised.') }}
          </p>
          <p v-else>
            {{ $t('This secret lets an agent do everything you can do in the admin panel, including deleting data and changing your security settings. Keep it like a password, give it to one agent only, and revoke it if that agent or its device is compromised.') }}
          </p>
        </div>
      </template>

      <div v-for="step in activeSteps" :key="step.snippet" class="af-mcp-setup-step mt-4">
        <p class="text-sm text-lightInputIconColor dark:text-darkInputIconColor">{{ step.hint }}</p>
        <div class="mt-2 flex items-start gap-2">
          <code :class="SNIPPET_CLASSES" class="min-w-0 flex-1 overflow-x-auto whitespace-pre">{{ step.snippet }}</code>
          <Button variant="secondary" @click="copy(step.snippet, $t('Copied'))">
            <IconCopy class="w-4 h-4" aria-hidden="true" />
            {{ $t('Copy') }}
          </Button>
        </div>
      </div>

      <!-- enter is handled on the wrapper so it fires once: Input spreads attrs on both its root and the input -->
      <div v-if="activeClient === 'Other' && !createdSecret" class="mt-4" @keydown.enter="createAuthSecret">
        <p class="text-sm text-lightInputIconColor dark:text-darkInputIconColor">{{ $t('Use one auth secret for one agent.') }}</p>
        <label class="mt-5 block text-sm font-medium text-lightTextLabel dark:text-darkTextLabel">{{ $t('Secret name') }}</label>
        <div class="mt-2">
          <Input v-model="secretName" type="text" fullWidth placeholder="Claude Code" />
        </div>
        <Checkbox v-model="secretReadOnly" :disabled="serverReadOnly" class="mt-4">
          {{ $t('Read only: the agent can only read data') }}
        </Checkbox>
      </div>

      <template v-if="showsCreatedSecret">
        <p class="mt-4 text-sm text-lightInputIconColor dark:text-darkInputIconColor">{{ $t('Prompt for your agent') }}</p>
        <pre :class="SNIPPET_CLASSES" class="mt-2 whitespace-pre-wrap">{{ setupPrompt }}</pre>
      </template>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, ButtonGroup, Checkbox, Dialog, Input, PageHeader, Table, Toggle } from '@/afcl';
import { IconCopy, IconPlus, IconTriangleAlert } from '@iconify-prerendered/vue-lucide';
import { useCoreStore } from '@/stores/core';
import adminforth from '@/adminforth';
import { callAdminForthApi, formatDateTime } from '@/utils';
import claudeCodeIcon from '@/assets/agents/claude-code.svg';
import codexIcon from '@/assets/agents/codex.svg';
import geminiIcon from '@/assets/agents/gemini.svg';

type Agent = { client: string; ver: string | null };
type AuthSecret = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedByAgent: Agent | null;
  readOnly: boolean;
  oauthClientId: string | null;
};
type Client = typeof CLIENTS[number];

const CLIENTS = ['Claude Code', 'Codex', 'Other'] as const;
const NON_SERVER_NAME_CHARACTER_RE = /[^a-z0-9]+/g;
const EDGE_HYPHEN_RE = /^-+|-+$/g;
const SNIPPET_CLASSES = 'rounded-default bg-lightSecondaryDarken px-3 py-1.5 font-mono text-[13px] leading-[22px] text-lightFormFieldTextColor dark:bg-darkSecondaryLighten dark:text-darkFormFieldTextColor';

const { t } = useI18n();
const coreStore = useCoreStore();
const brandName = computed<string>(() => coreStore.config?.brandName);
const activeClient = ref<Client>('Claude Code');
// Built by the plugin from adminPanelOrigin: OAuth accepts tokens only for this exact URL.
const mcpUrl = ref('');

const authSecrets = ref<AuthSecret[]>([]);
const loading = ref(true);
const dialogRef = ref();
const secretName = ref('');
// Read-only is the default; with the plugin readOnly option the checkbox stays checked and locked.
const secretReadOnly = ref(true);
const serverReadOnly = ref(false);
const createdSecret = ref('');
const creating = ref(false);
const revokingId = ref<string | null>(null);
const updatingId = ref<string | null>(null);

const columns = computed(() => [
  { label: t('Name'), fieldName: 'name', sortable: true },
  { label: t('Read only'), fieldName: 'readOnly' },
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

const createdSecretReadOnly = computed(() => serverReadOnly.value || secretReadOnly.value);

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
      mcpUrl.value = response.mcpUrl;
      serverReadOnly.value = response.serverReadOnly;
    }
  } finally {
    loading.value = false;
  }
}

function openConnectDialog() {
  secretName.value = '';
  secretReadOnly.value = true;
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
      body: { name: secretName.value.trim(), readOnly: secretReadOnly.value },
    });
    if (response?.secret) {
      createdSecret.value = response.secret;
      await loadAuthSecrets();
    }
  } finally {
    creating.value = false;
  }
}

async function setReadOnly(authSecret: AuthSecret, readOnly: boolean) {
  authSecret.readOnly = readOnly;
  updatingId.value = authSecret.id;
  try {
    const confirmed = readOnly || await adminforth.confirm({
      message: t('Allow "{name}" to do everything you can do in the admin panel, including deleting data and changing your security settings?', { name: authSecret.name }),
      yes: t('Allow'),
      no: t('Cancel'),
      dangerous: true,
    });
    if (confirmed) {
      const response = await callAdminForthApi({
        method: 'PATCH',
        path: '/mcp/auth-secrets',
        body: { id: authSecret.id, readOnly },
      });
      if (response && !response.error && !readOnly) {
        adminforth.alert({ message: t('Reconnect the agent so it loads the tools that change data.'), variant: 'success' });
      }
    }
    await loadAuthSecrets();
  } finally {
    updatingId.value = null;
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
