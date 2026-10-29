<template>
  <span v-if="value" class="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[12.5px]">
    <img v-if="logo" :src="logo" class="w-4 h-4 shrink-0" alt="" />
    <IconBot v-else class="w-4 h-4 shrink-0 text-lightInputIconColor dark:text-darkInputIconColor" aria-hidden="true" />
    {{ label }}
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { IconBot } from '@iconify-prerendered/vue-lucide';
import claudeCodeLogo from './icons/claude-code.svg';
import codexLogo from './icons/codex.svg';
import geminiLogo from './icons/gemini.svg';
import type { AdminForthResourceColumnCommon } from '@/types/Common';

// agent names as formatMcpExecutedBy writes them, the others (af-agent of @adminforth/agent, unknown MCP clients) get the bot icon
const AGENT_LOGOS: Record<string, string> = {
  'claude-code': claudeCodeLogo,
  claude: claudeCodeLogo,
  codex: codexLogo,
  gemini: geminiLogo,
};
// a value is "<agent>@<version> | <auth secret name>" or just "<agent>"
const AGENT_NAME_RE = /^[^@|\s]+/;

const props = defineProps<{
  column: AdminForthResourceColumnCommon;
  record: Record<string, any>;
}>();

const value = computed<string | null>(() => props.record[props.column.name]);
const logo = computed(() => AGENT_LOGOS[value.value!.match(AGENT_NAME_RE)![0]]);
const label = computed(() => value.value!.replace(' | ', ' · '));
</script>
