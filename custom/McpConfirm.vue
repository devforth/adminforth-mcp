<template>
  <div class="af-mcp-confirm flex min-h-screen items-center justify-center bg-lightHtml p-4 dark:bg-darkHtml">
    <Card v-if="resultMessage || error" class="af-mcp-confirm-card w-full max-w-lg">
      <template v-if="pending">
        <h1 :class="TITLE_CLASSES">{{ title }}</h1>
        <p :class="TEXT_CLASSES">
          <b class="font-semibold text-lightCardTitle dark:text-darkCardTitle">{{ pending.connectionName }}</b>
          {{ $t('asks to run this action on your behalf. | asks to run these actions on your behalf.', pending.actions.length) }}
        </p>
        <p
          class="af-mcp-confirm-result mt-4 flex items-start gap-2 text-sm font-medium"
          :class="failed ? 'text-lightDanger dark:text-darkDanger' : 'text-lightSuccess dark:text-darkSuccess'"
        >
          <component :is="failed ? IconCircleAlert : IconCircleCheck" class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {{ resultMessage }}
        </p>
        <ul v-if="failedErrors.length" class="mt-2 list-disc space-y-1 pl-10 text-sm text-lightDanger dark:text-darkDanger">
          <li v-for="(failedError, i) in failedErrors" :key="i">{{ failedError }}</li>
        </ul>
      </template>
      <template v-else>
        <h1 :class="TITLE_CLASSES">{{ $t('Cannot run the action') }}</h1>
        <p :class="TEXT_CLASSES">{{ error }}</p>
      </template>
    </Card>
    <Spinner v-else-if="running" class="h-8 w-8" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { Card, Spinner } from '@/afcl';
import { IconCircleAlert, IconCircleCheck } from '@iconify-prerendered/vue-lucide';
import { callAdminForthApi } from '@/utils';

type PendingAction = {
  id: string;
  actionDescription?: string;
  path: string;
  arguments: Record<string, unknown>;
};
type PendingConfirmation = {
  connectionName: string;
  actions: PendingAction[];
};
type ActionResult = { id: string; output: { error?: string }; isError: boolean };

const TITLE_CLASSES = 'text-lg font-semibold tracking-tight text-lightCardTitle dark:text-darkCardTitle';
const TEXT_CLASSES = 'mt-2 text-sm text-lightCardDescription dark:text-darkCardDescription';
const { t } = useI18n();
const route = useRoute();
const pending = ref<PendingConfirmation | null>(null);
const error = ref('');
const failed = ref(false);
const running = ref(false);
const resultMessage = ref('');
const failedErrors = ref<string[]>([]);
const ids = computed(() => pending.value!.actions.map((action) => action.id));
const title = computed(() => {
  const actions = pending.value!.actions;
  return actions.length > 1
    ? t('Confirm {count} actions of your agent', { count: actions.length })
    : actions[0].actionDescription ?? t('Confirm the action of your agent');
});
// Without a description of an action, the modal shows the raw call of the agent instead.
const modalContent = computed(() => {
  const actions = pending.value!.actions;
  if (actions.length > 1) {
    return { items: actions.map((action) => action.actionDescription ?? `${action.path} ${JSON.stringify(action.arguments)}`) };
  }
  const [action] = actions;
  return action.actionDescription ? {} : { details: `${action.path}\n${JSON.stringify(action.arguments, null, 2)}` };
});

onMounted(async () => {
  const response = await callAdminForthApi({ method: 'GET', path: `/mcp/confirmation?id=${encodeURIComponent(String(route.query.id))}` });
  if (response?.error) error.value = response.error;
  else if (response) {
    pending.value = response;
    await confirm();
  }
});

async function confirm() {
  try {
    let verificationResult;
    try {
      verificationResult = await (window as any).adminforthTwoFaModal.get2FaConfirmationResult(title.value, undefined, modalContent.value);
    } catch (error) {
      await decline();
      if (error !== 'Cancel' && !failed.value) {
        failed.value = true;
        resultMessage.value = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    running.value = true;
    const response = await callAdminForthApi({ method: 'POST', path: '/mcp/confirmation/run', body: { ids: ids.value, verificationResult } });
    if (!response || response.error) {
      failed.value = true;
      resultMessage.value = response?.error ?? t('The action failed.');
      return;
    }
    const errors = (response.results as ActionResult[])
      .filter((result) => result.isError)
      .map((result) => result.output?.error ?? t('The action failed.'));
    failed.value = errors.length > 0;
    if (!errors.length) {
      resultMessage.value = t('Done. Your agent got the result. You can close this page.');
    } else if (ids.value.length === 1) {
      resultMessage.value = errors[0];
    } else {
      resultMessage.value = t('{failed} of {count} actions failed:', { failed: errors.length, count: ids.value.length });
      failedErrors.value = errors;
    }
  } catch (error) {
    failed.value = true;
    resultMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function decline() {
  const response = await callAdminForthApi({ method: 'POST', path: '/mcp/confirmation/decline', body: { ids: ids.value } });
  failed.value = Boolean(response?.error);
  resultMessage.value = response?.error ?? t('Declined. Your agent was told.');
}
</script>
