<script setup lang="ts">
import type {
  OptimizeAgentTaskPromptResult,
  TaskPromptClarificationAnswer,
} from '@viewport-lab/shared'
import { computed, ref, watch } from 'vue'

const customOptionId = '__custom__'

const props = defineProps<{
  visible: boolean
  result: OptimizeAgentTaskPromptResult | null
  loading: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  submitClarifications: [clarifications: TaskPromptClarificationAnswer[]]
  apply: [optimizedTask: string]
  close: []
}>()

const selections = ref<Record<string, string>>({})
const customAnswers = ref<Record<string, string>>({})
const optimizedTask = ref('')

const questions = computed(() =>
  props.result?.status === 'needs_clarification' ? props.result.questions : [],
)
const isReady = computed(() => props.result?.status === 'ready')
const canSubmitClarifications = computed(() =>
  questions.value.every((question) => {
    const selected = selections.value[question.id]
    return selected && (selected !== customOptionId || customAnswers.value[question.id]?.trim())
  }),
)
const canApply = computed(() => optimizedTask.value.trim().length > 0 && !props.loading)

watch(
  () => props.result,
  (result) => {
    selections.value = {}
    customAnswers.value = {}
    optimizedTask.value = result?.status === 'ready' ? result.optimizedTask : ''
  },
)

function optionLetter(index: number): string {
  return String.fromCharCode(65 + index)
}

function submitClarifications(): void {
  if (!canSubmitClarifications.value || props.loading) return
  const clarifications = questions.value.map((question) => {
    const selection = selections.value[question.id]
    const option = question.options.find((item) => item.id === selection)
    return {
      question: question.question,
      answer:
        selection === customOptionId
          ? customAnswers.value[question.id]?.trim() ?? ''
          : option?.label ?? '',
    }
  })
  emit('submitClarifications', clarifications)
}

function closeDialog(): void {
  emit('close')
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    width="min(720px, calc(100vw - 32px))"
    :close-on-click-modal="!loading"
    :close-on-press-escape="!loading"
    :show-close="!loading"
    @update:model-value="emit('update:visible', $event)"
    @close="closeDialog"
  >
    <template #header>
      <div class="dialog-title">
        <strong>{{ isReady ? '确认优化后的任务描述' : '补充任务关键信息' }}</strong>
        <span>AI 不会访问页面或启动 Agent，仅帮助澄清并整理任务描述。</span>
      </div>
    </template>

    <template v-if="result?.status === 'needs_clarification'">
      <p class="dialog-intro">请选择最符合本次检测目标的答案；选择“其他”时可自行补充。</p>
      <section v-for="(question, questionIndex) in questions" :key="question.id" class="question-card">
        <strong>{{ questionIndex + 1 }}. {{ question.question }}</strong>
        <el-radio-group v-model="selections[question.id]" class="question-options">
          <el-radio v-for="(option, optionIndex) in question.options" :key="option.id" :value="option.id">
            {{ optionLetter(optionIndex) }}. {{ option.label }}
          </el-radio>
          <el-radio :value="customOptionId">其他（自行补充）</el-radio>
        </el-radio-group>
        <el-input
          v-if="selections[question.id] === customOptionId"
          v-model="customAnswers[question.id]"
          class="custom-answer"
          maxlength="1000"
          show-word-limit
          placeholder="请输入本题的补充说明"
        />
      </section>
    </template>

    <template v-else-if="isReady">
      <p class="dialog-intro">你可以继续手动调整。点击应用后才会替换当前 AI 任务描述。</p>
      <el-input v-model="optimizedTask" type="textarea" :rows="12" maxlength="12000" show-word-limit />
    </template>

    <template #footer>
      <el-button :disabled="loading" @click="emit('update:visible', false)">取消</el-button>
      <el-button
        v-if="result?.status === 'needs_clarification'"
        type="primary"
        :loading="loading"
        :disabled="!canSubmitClarifications"
        @click="submitClarifications"
      >
        生成优化结果
      </el-button>
      <el-button v-else-if="isReady" type="primary" :disabled="!canApply" @click="emit('apply', optimizedTask.trim())">
        应用到任务描述
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dialog-title {
  display: grid;
  gap: 5px;
}

.dialog-title strong {
  color: #29304a;
  font-size: 18px;
}

.dialog-title span,
.dialog-intro {
  color: #8a92a8;
  font-size: 13px;
  line-height: 1.65;
}

.dialog-intro {
  margin: 0 0 16px;
}

.question-card {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid #e4e6ef;
  border-radius: 12px;
}

.question-card + .question-card {
  margin-top: 12px;
}

.question-card strong {
  color: #3b435c;
  line-height: 1.55;
}

.question-options {
  display: grid;
  gap: 10px;
}

.question-options :deep(.el-radio) {
  height: auto;
  margin-right: 0;
  white-space: normal;
}

.question-options :deep(.el-radio__label) {
  line-height: 1.5;
}

.custom-answer {
  margin-top: -3px;
}
</style>
