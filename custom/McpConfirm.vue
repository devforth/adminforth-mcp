<template>
  <div class="af-mcp-confirm flex min-h-screen items-center justify-center bg-gray-100 p-4 dark:bg-gray-800">
    <div class="w-full max-w-lg rounded-lg bg-white p-6 shadow dark:bg-gray-700">
      <template v-if="pending">
        <h1 class="text-xl font-medium text-gray-900 dark:text-white">{{ title }}</h1>
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">
          <b>{{ pending.connectionName }}</b>
          {{ pending.actionDescription
            ? $t('asks to run this action on your behalf.')
            : $t('asks to run {path} on your behalf with these arguments:', { path: pending.path }) }}
        </p>
        <pre v-if="!pending.actionDescription" class="mt-3 max-h-80 overflow-auto rounded-default bg-gray-100 p-3 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100">{{ argumentsText }}</pre>
        <p v-if="resultMessage" class="mt-4 text-sm font-medium" :class="failed ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'">
          {{ resultMessage }}
        </p>
        <div v-if="!finished" class="mt-6 flex justify-end gap-2">
          <Button variant="secondary" :disabled="running" @click="decline">{{ $t('Decline') }}</Button>
          <Button :loader="running" :disabled="running" @click="confirm">{{ $t('Confirm') }}</Button>
        </div>
      </template>
      <template v-else-if="error">
        <h1 class="text-xl font-medium text-gray-900 dark:text-white">{{ $t('Cannot run the action') }}</h1>
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">{{ error }}</p>
      </template>
      <Spinner v-else class="mx-auto h-8 w-8" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Button, Spinner } from '@/afcl';
import { callAdminForthApi } from '@/utils';

type PendingConfirmation = {
  actionDescription?: string;
  connectionName: string;
  path: string;
  arguments: Record<string, unknown>;
};
const { t } = useI18n();
const route = useRoute();
const id = String(route.query.id);
const pending = ref<PendingConfirmation | null>(null);
const error = ref('');
const running = ref(false);
const finished = ref(false);
const failed = ref(false);
const resultMessage = ref('');
const argumentsText = computed(() => JSON.stringify(pending.value?.arguments, null, 2));
const title = computed(() => pending.value?.actionDescription ?? t('Confirm the action of your agent'));

onMounted(async () => {
  const response = await callAdminForthApi({ method: 'GET', path: `/mcp/confirmation?id=${encodeURIComponent(id)}` });
  if (response?.error) error.value = response.error;
  else if (response) pending.value = response;
});

async function confirm() {
  running.value = true;
  try {
    let verificationResult;
    try {
      verificationResult = await (window as any).adminforthTwoFaModal.get2FaConfirmationResult(title.value);
    } catch (error) {
      await decline();
      if (error !== 'Cancel' && finished.value) {
        failed.value = true;
        resultMessage.value = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    const response = await callAdminForthApi({ method: 'POST', path: '/mcp/confirmation/run', body: { id, verificationResult } });
    failed.value = !response || Boolean(response.error) || response.ok === false;
    finished.value = true;
    resultMessage.value = failed.value
      ? response?.error ?? t('The action failed.')
      : t('Done. Your agent got the result. You can close this page.');
  } catch (error) {
    if (error !== 'Cancel') {
      failed.value = true;
      resultMessage.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    running.value = false;
  }
}

async function decline() {
  const response = await callAdminForthApi({ method: 'POST', path: '/mcp/confirmation/decline', body: { id } });
  failed.value = Boolean(response?.error);
  finished.value = !failed.value;
  resultMessage.value = response?.error ?? t('Declined. Your agent was told.');
}
</script>
