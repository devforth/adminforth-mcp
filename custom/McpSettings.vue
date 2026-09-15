<template>
  <div class="af-mcp-settings flex flex-col justify-center mr-6 md:mr-12">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-3xl font-semibold leading-none text-gray-800 dark:text-gray-50">
          {{ $t('MCP Settings') }}
        </h2>
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">
          {{ $t('Create a separate auth secret for each AI agent. Secrets are shown only once.') }}
        </p>
      </div>
      <Button @click="openCreateDialog">
        {{ $t('Create auth secret') }}
      </Button>
    </div>

    <div class="mt-6 rounded-default border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800">
      <p class="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">{{ $t('MCP server URL') }}</p>
      <div class="mt-2 flex items-center gap-2">
        <code class="min-w-0 flex-1 overflow-x-auto rounded bg-white px-3 py-2 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-100">{{ mcpUrl }}</code>
        <Button variant="secondary" @click="copy(mcpUrl, $t('MCP server URL copied'))">
          {{ $t('Copy') }}
        </Button>
      </div>
      <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">
        <code>Authorization: Bearer &lt;secret&gt;</code>
      </p>
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
        <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{{ formatDate(item.createdAt) }}</p>
      </template>

      <template #cell:lastUsedByAgent="{ item }">
        <div v-if="item.lastUsedByAgent" class="flex items-center gap-2">
          <img v-if="describeAgent(item.lastUsedByAgent).icon" :src="describeAgent(item.lastUsedByAgent).icon" class="h-5 w-5" alt="" />
          <span>{{ describeAgent(item.lastUsedByAgent).label }}</span>
        </div>
        <span v-else class="text-gray-400">{{ $t('Not used yet') }}</span>
      </template>

      <template #cell:lastUsedAt="{ item }">
        {{ item.lastUsedAt ? formatDate(item.lastUsedAt) : $t('Never') }}
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
      class="w-full max-w-xl"
      :header="createdSecret ? $t('Auth secret created') : $t('Create MCP auth secret')"
      :buttons="dialogButtons"
    >
      <!-- enter is handled on the wrapper so it fires once: Input spreads attrs on both its root and the input -->
      <div v-if="!createdSecret" @keydown.enter="createAuthSecret">
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ $t('Use one auth secret for one agent.') }}</p>
        <label class="mt-5 block text-sm font-medium text-gray-700 dark:text-gray-200">{{ $t('Secret name') }}</label>
        <div class="mt-2">
          <Input v-model="secretName" type="text" fullWidth placeholder="Claude Code" />
        </div>
      </div>
      <div v-else>
        <p class="text-sm text-amber-700 dark:text-amber-300">{{ $t('Copy it now. You will not be able to view it again.') }}</p>
        <p class="mt-3 rounded-default border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          {{ $t('This secret lets an agent do everything you can do in the admin panel, including deleting data and changing your security settings. Keep it like a password, give it to one agent only, and revoke it if that agent or its device is compromised.') }}
        </p>
        <code class="mt-4 block overflow-x-auto rounded-default bg-gray-100 p-3 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100">{{ createdSecret }}</code>
        <p class="mt-5 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">{{ $t('Prompt for your agent') }}</p>
        <pre class="mt-2 whitespace-pre-wrap rounded-default bg-gray-100 p-3 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-100">{{ setupPrompt }}</pre>
      </div>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Dialog, Input, Table } from '@/afcl';
import adminforth from '@/adminforth';
import { callAdminForthApi } from '@/utils';
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
};

const { t } = useI18n();

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

const dialogButtons = computed(() => createdSecret.value
  ? [
      {
        label: t('Copy prompt'),
        options: { variant: 'secondary' },
        onclick: () => copy(setupPrompt.value, t('Prompt copied')),
      },
      {
        label: t('Done'),
        onclick: (dialog: { hide: () => void }) => dialog.hide(),
      },
    ]
  : [
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
    ]
);

const mcpUrl = computed(() => {
  const baseUrl = (import.meta.env.VITE_ADMINFORTH_PUBLIC_PATH || '').replace(/\/$/, '');
  return `${window.location.origin}${baseUrl}/adminapi/v1/mcp`;
});
const setupPrompt = computed(() => [
  'Add this remote MCP server to the current agent:',
  `URL: ${mcpUrl.value}`,
  `Header: Authorization: Bearer ${createdSecret.value || '<secret>'}`,
  'Use this auth secret only for this agent.',
].join('\n'));

onMounted(loadAuthSecrets);

async function loadAuthSecrets() {
  loading.value = true;
  try {
    const response = await callAdminForthApi({ method: 'GET', path: '/mcp/auth-secrets' });
    if (response) authSecrets.value = response.authSecrets;
  } finally {
    loading.value = false;
  }
}

function openCreateDialog() {
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
    message: t('Revoke MCP auth secret "{name}"? Any agent using it will lose access.', { name: authSecret.name }),
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

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

async function copy(value: string, message: string) {
  await navigator.clipboard.writeText(value);
  adminforth.alert({ message, variant: 'success' });
}
</script>
