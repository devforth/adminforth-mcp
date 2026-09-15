<template>
  <div class="flex flex-col justify-center mr-6 md:mr-12">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-3xl font-semibold leading-none text-gray-800 dark:text-gray-50">
          {{ $t('MCP Settings') }}
        </h2>
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">
          {{ $t('Create a separate auth secret for each AI agent. Secrets are shown only once.') }}
        </p>
      </div>
      <button
        type="button"
        class="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-700"
        @click="openCreateDialog"
      >
        {{ $t('Create auth secret') }}
      </button>
    </div>

    <div class="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800">
      <p class="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">{{ $t('MCP server URL') }}</p>
      <div class="mt-2 flex items-center gap-2">
        <code class="min-w-0 flex-1 overflow-x-auto rounded bg-white px-3 py-2 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-100">{{ mcpUrl }}</code>
        <button class="text-sm font-medium text-blue-700 dark:text-blue-400" @click="copy(mcpUrl)">
          {{ $t('Copy') }}
        </button>
      </div>
      <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">
        <code>Authorization: Bearer &lt;secret&gt;</code>
      </p>
    </div>

    <div v-if="authSecrets.length" class="mt-6 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
      <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th class="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">{{ $t('Name') }}</th>
            <th class="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">{{ $t('Last used by') }}</th>
            <th class="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">{{ $t('Last usage') }}</th>
            <th class="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500 dark:text-gray-400">{{ $t('Actions') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
          <tr v-for="authSecret in authSecrets" :key="authSecret.id">
            <td class="px-4 py-3">
              <p class="font-medium text-gray-900 dark:text-white">{{ authSecret.name }}</p>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{{ formatDate(authSecret.createdAt) }}</p>
            </td>
            <td class="px-4 py-3 text-sm text-gray-700 dark:text-gray-200">
              <div v-if="authSecret.lastUsedByAgent" class="flex items-center gap-2">
                <img v-if="describeAgent(authSecret.lastUsedByAgent).icon" :src="describeAgent(authSecret.lastUsedByAgent).icon" class="h-5 w-5" alt="" />
                <span>{{ describeAgent(authSecret.lastUsedByAgent).label }}</span>
              </div>
              <span v-else class="text-gray-400">{{ $t('Not used yet') }}</span>
            </td>
            <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
              {{ authSecret.lastUsedAt ? formatDate(authSecret.lastUsedAt) : $t('Never') }}
            </td>
            <td class="px-4 py-3 text-right">
              <button
                type="button"
                class="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950"
                :disabled="revokingId === authSecret.id"
                @click="revoke(authSecret)"
              >
                {{ revokingId === authSecret.id ? $t('Revoking') : $t('Revoke') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="!loading" class="mt-6 text-sm text-gray-500 dark:text-gray-400">
      {{ $t('No MCP auth secrets yet.') }}
    </p>

    <div v-if="dialogOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="w-full max-w-xl rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <template v-if="!createdSecret">
          <h3 class="text-xl font-semibold text-gray-900 dark:text-white">{{ $t('Create MCP auth secret') }}</h3>
          <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">{{ $t('Use one auth secret for one agent.') }}</p>
          <label class="mt-5 block text-sm font-medium text-gray-700 dark:text-gray-200">{{ $t('Secret name') }}</label>
          <input
            v-model="secretName"
            class="mt-2 block w-full rounded-lg border border-gray-300 bg-gray-50 p-2.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            placeholder="Claude Code"
            @keydown.enter="createAuthSecret"
          />
          <div class="mt-6 flex justify-end gap-3">
            <button class="px-4 py-2 text-sm text-gray-600 dark:text-gray-300" @click="closeDialog">{{ $t('Cancel') }}</button>
            <button
              class="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-blue-600"
              :disabled="creating || !secretName.trim()"
              @click="createAuthSecret"
            >
              {{ creating ? $t('Creating') : $t('Create') }}
            </button>
          </div>
        </template>
        <template v-else>
          <h3 class="text-xl font-semibold text-gray-900 dark:text-white">{{ $t('Auth secret created') }}</h3>
          <p class="mt-2 text-sm text-amber-700 dark:text-amber-300">{{ $t('Copy it now. You will not be able to view it again.') }}</p>
          <code class="mt-4 block overflow-x-auto rounded-lg bg-gray-100 p-3 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100">{{ createdSecret }}</code>
          <p class="mt-5 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">{{ $t('Prompt for your agent') }}</p>
          <pre class="mt-2 whitespace-pre-wrap rounded-lg bg-gray-100 p-3 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-100">{{ setupPrompt }}</pre>
          <div class="mt-6 flex justify-end gap-3">
            <button class="text-sm font-medium text-blue-700 dark:text-blue-400" @click="copy(setupPrompt)">{{ $t('Copy prompt') }}</button>
            <button class="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white dark:bg-blue-600" @click="closeDialog">{{ $t('Done') }}</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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

const authSecrets = ref<AuthSecret[]>([]);
const loading = ref(true);
const dialogOpen = ref(false);
const secretName = ref('');
const createdSecret = ref('');
const creating = ref(false);
const revokingId = ref<string | null>(null);

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
  dialogOpen.value = true;
}

function closeDialog() {
  dialogOpen.value = false;
  createdSecret.value = '';
}

async function createAuthSecret() {
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
  if (!window.confirm(`Revoke MCP auth secret "${authSecret.name}"?`)) return;
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

async function copy(value: string) {
  await navigator.clipboard.writeText(value);
}
</script>
