<template>
  <div class="af-mcp-authorize flex min-h-screen items-center justify-center bg-gray-100 p-4 dark:bg-gray-800">
    <div class="w-full max-w-lg rounded-lg bg-white p-6 shadow dark:bg-gray-700">
      <template v-if="framed">
        <h1 class="text-xl font-medium text-gray-900 dark:text-white">{{ $t('Cannot connect MCP client') }}</h1>
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">
          {{ $t('This page is embedded in another site. Open it in a separate browser tab to connect your MCP client.') }}
        </p>
      </template>
      <template v-else-if="authorization">
        <h1 class="text-xl font-medium text-gray-900 dark:text-white">
          {{ $t('Connect {client}?', { client: authorization.clientName }) }}
        </h1>
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">
          <b>{{ authorization.clientName }}</b>
          <span v-if="authorization.clientHost"> ({{ authorization.clientHost }})</span>
          {{ $t('asks to act on your behalf in {brand}: it will see and change everything you can.', { brand: brandName }) }}
        </p>
        <p v-if="authorization.loopbackRedirect" class="mt-3 text-sm font-medium text-amber-700 dark:text-amber-300">
          {{ $t('After you answer, your browser returns to an app running on this computer. Allow only if you have just started connecting {client} yourself.', { client: authorization.clientName }) }}
        </p>
        <p v-else class="mt-3 text-sm text-gray-600 dark:text-gray-300">
          {{ $t('After you answer, your browser returns to {host}.', { host: authorization.redirectHost }) }}
        </p>
        <div class="mt-6 flex justify-end gap-2">
          <Button variant="secondary" :disabled="resolving" @click="resolve(false)">{{ $t('Deny') }}</Button>
          <Button :loader="resolving" :disabled="resolving" @click="resolve(true)">{{ $t('Allow') }}</Button>
        </div>
      </template>
      <template v-else-if="error">
        <h1 class="text-xl font-medium text-gray-900 dark:text-white">{{ $t('Cannot connect MCP client') }}</h1>
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">{{ error }}</p>
      </template>
      <Spinner v-else class="mx-auto h-8 w-8" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Button, Spinner } from '@/afcl';
import { useCoreStore } from '@/stores/core';
import { callAdminForthApi } from '@/utils';

type Authorization = {
  clientName: string;
  clientHost: string | null;
  redirectHost: string;
  loopbackRedirect: boolean;
};

const route = useRoute();
const coreStore = useCoreStore();
const brandName = computed(() => coreStore.config?.brandName);

// The signed authorization request /mcp/oauth/authorize redirected the browser here with
const request = String(route.query.request);
const authorization = ref<Authorization | null>(null);
const error = ref('');
const resolving = ref(false);
// AdminForth sends no frame protection headers, so a site sharing the admin panel domain could load this page in
// an invisible frame and trick a click on Allow (clickjacking). The consent is never offered inside a frame.
const framed = window.top !== window.self;

onMounted(async () => {
  if (framed) return;
  const response = await callAdminForthApi({
    method: 'GET',
    path: `/mcp/oauth/authorization?request=${encodeURIComponent(request)}`,
  });
  if (response?.error) {
    error.value = response.error_description;
  } else if (response) {
    authorization.value = response;
  }
});

async function resolve(approved: boolean) {
  resolving.value = true;
  const response = await callAdminForthApi({
    method: 'POST',
    path: '/mcp/oauth/authorization',
    body: { request, approved },
  });
  if (response?.redirectUrl) {
    window.location.href = response.redirectUrl;
    return;
  }
  resolving.value = false;
  if (response?.error) {
    authorization.value = null;
    error.value = response.error_description;
  }
}
</script>
