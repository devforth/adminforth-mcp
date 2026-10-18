<template>
  <div class="af-mcp-authorize flex min-h-screen items-center justify-center bg-lightHtml p-4 dark:bg-darkHtml">
    <Spinner v-if="!framed && !authorization && !error" class="h-8 w-8" />
    <Card v-else class="af-mcp-authorize-card w-full max-w-lg">
      <template v-if="framed">
        <h1 :class="TITLE_CLASSES">{{ $t('Cannot connect MCP client') }}</h1>
        <p :class="TEXT_CLASSES">
          {{ $t('This page is embedded in another site. Open it in a separate browser tab to connect your MCP client.') }}
        </p>
      </template>
      <template v-else-if="authorization">
        <h1 :class="TITLE_CLASSES">
          {{ $t('Connect {client}?', { client: authorization.clientName }) }}
        </h1>
        <p :class="TEXT_CLASSES">
          <b class="font-semibold text-lightCardTitle dark:text-darkCardTitle">{{ authorization.clientName }}</b>
          <span v-if="authorization.clientHost"> ({{ authorization.clientHost }})</span>
          <template v-if="readOnly">
            {{ $t('asks to act on your behalf in {brand}: it will see all data you can see, but not change it.', { brand: brandName }) }}
          </template>
          <template v-else>
            {{ $t('asks to act on your behalf in {brand}: it will see and change everything you can.', { brand: brandName }) }}
          </template>
        </p>
        <Checkbox v-model="readOnlyChosen" :disabled="authorization.serverReadOnly" class="mt-4">
          {{ $t('Read only: the agent can only read data') }}
        </Checkbox>
        <div
          v-if="authorization.loopbackRedirect"
          class="mt-4 flex items-start gap-2 rounded-default border border-lightWarningBorder bg-lightWarningSoft p-3 text-sm text-lightWarning dark:border-darkWarningBorder dark:bg-darkWarningSoft dark:text-darkWarning"
        >
          <IconTriangleAlert class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{{ $t('After you answer, your browser returns to an app running on this computer. Allow only if you have just started connecting {client} yourself.', { client: authorization.clientName }) }}</p>
        </div>
        <p v-else :class="TEXT_CLASSES">
          {{ $t('After you answer, your browser returns to {host}.', { host: authorization.redirectHost }) }}
        </p>
        <div class="mt-6 flex justify-end gap-2">
          <Button variant="secondary" :disabled="resolving" @click="resolve(false)">{{ $t('Deny') }}</Button>
          <Button :loader="resolving" :disabled="resolving || !armed" @click="resolve(true)">{{ $t('Allow') }}</Button>
        </div>
      </template>
      <template v-else>
        <h1 :class="TITLE_CLASSES">{{ $t('Cannot connect MCP client') }}</h1>
        <p :class="TEXT_CLASSES">{{ error }}</p>
      </template>
    </Card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Button, Card, Checkbox, Spinner } from '@/afcl';
import { IconTriangleAlert } from '@iconify-prerendered/vue-lucide';
import { useCoreStore } from '@/stores/core';
import { callAdminForthApi } from '@/utils';

// Long enough to swallow the second click of a double click, too short for a reader to notice.
const ALLOW_DELAY_MS = 500;
const TITLE_CLASSES = 'text-lg font-semibold tracking-tight text-lightCardTitle dark:text-darkCardTitle';
const TEXT_CLASSES = 'mt-2 text-sm text-lightCardDescription dark:text-darkCardDescription';

type Authorization = {
  clientName: string;
  clientHost: string | null;
  redirectHost: string;
  loopbackRedirect: boolean;
  serverReadOnly: boolean;
};

const route = useRoute();
const coreStore = useCoreStore();
const brandName = computed(() => coreStore.config?.brandName);

// The signed authorization request /mcp/oauth/authorize redirected the browser here with
const request = String(route.query.request);
const authorization = ref<Authorization | null>(null);
const error = ref('');
const resolving = ref(false);
// Read-only is the default. With the plugin readOnly option every connection is read-only, so the checkbox stays
// checked and locked.
const readOnlyChosen = ref(true);
const readOnly = computed(() => authorization.value?.serverReadOnly || readOnlyChosen.value);
// AdminForth sends no frame protection headers, so a site sharing the admin panel domain could load this page in
// an invisible frame and trick a click on Allow (clickjacking). The consent is never offered inside a frame.
const framed = window.top !== window.self;

// Double-clickjacking: a page asks for a double click, swaps itself for this one on the first click, and the second
// click lands on Allow before anyone can read it. Allow is enabled only once the page has been visible and focused
// for a moment, and disabled again whenever it loses either.
const armed = ref(false);
let armTimer: ReturnType<typeof setTimeout> | undefined;

function disarm() {
  clearTimeout(armTimer);
  armed.value = false;
}

function arm() {
  disarm();
  if (document.visibilityState === 'visible' && document.hasFocus()) {
    armTimer = setTimeout(() => { armed.value = true; }, ALLOW_DELAY_MS);
  }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') arm();
  else disarm();
}

onBeforeUnmount(() => {
  disarm();
  window.removeEventListener('focus', arm);
  window.removeEventListener('blur', disarm);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});

onMounted(async () => {
  if (framed) return;
  window.addEventListener('focus', arm);
  window.addEventListener('blur', disarm);
  document.addEventListener('visibilitychange', onVisibilityChange);
  const response = await callAdminForthApi({
    method: 'GET',
    path: `/mcp/oauth/authorization?request=${encodeURIComponent(request)}`,
  });
  if (response?.error) {
    error.value = response.error_description;
  } else if (response) {
    authorization.value = response;
    // the delay counts from when the buttons are on the screen
    await nextTick();
    arm();
  }
});

async function resolve(approved: boolean) {
  resolving.value = true;
  const response = await callAdminForthApi({
    method: 'POST',
    path: '/mcp/oauth/authorization',
    body: { request, approved, readOnly: readOnlyChosen.value },
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
